package scan

// Phase 1 回归：CLI / 桌面版共用的本地候选池读写层。
//
// 这里的 poolGolden 与 packages/cli/test/external-pool.test.ts 里的
// GOLDEN_POOL **必须逐字节相同**：两端各自断言 parse → serialize 往返不变，
// 等价于锁死跨语言的 JSON 排版契约。改任一侧都要同步改另一侧。

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// poolGolden 是「Go 侧写出的合法池文件」的标准样本（2 空格缩进 + 结尾换行）。
const poolGolden = `{
  "schema": 1,
  "updatedAt": 1794000000000,
  "candidates": [
    {
      "key": "104.16.0.1:443",
      "ip": "104.16.0.1",
      "port": 443,
      "ipVersion": 4,
      "candidateType": "entry_ip",
      "sources": [
        "github_best_cf_ips",
        "custom_001"
      ],
      "firstSeen": 1794000000000,
      "lastSeen": 1794000000000,
      "lightCheck": {
        "tcpOk": true,
        "tlsOk": true,
        "tlsMs": 168,
        "at": 1794000000000
      },
      "fullTest": null,
      "status": "pending",
      "failCount": 0,
      "successCount": 0
    }
  ]
}
`

const testNow = int64(1794000000000)

func poolTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CFPILOT_CONFIG_DIR", dir)
	return dir
}

func candidate(ip, source string) CandidateInput {
	return CandidateInput{IP: ip, Source: source}
}

// ------------------------------------------------------------------
// 跨语言序列化契约
// ------------------------------------------------------------------

func TestPoolGoldenRoundTrip(t *testing.T) {
	poolTestDir(t)
	pool := ParsePool(poolGolden)
	if len(pool.Candidates) != 1 {
		t.Fatalf("golden 应解析出 1 条候选，实际 %d", len(pool.Candidates))
	}
	got, err := SerializePool(pool)
	if err != nil {
		t.Fatal(err)
	}
	if got != poolGolden {
		t.Fatalf("parse → serialize 往返改变了字节：\n--- got ---\n%s\n--- want ---\n%s", got, poolGolden)
	}
}

func TestPoolEmptySerialization(t *testing.T) {
	poolTestDir(t)
	got, err := SerializePool(EmptyPool())
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"schema\": 1,\n  \"updatedAt\": 0,\n  \"candidates\": []\n}\n"
	if got != want {
		t.Fatalf("空池必须是 [] 而不是 null：\ngot  %q\nwant %q", got, want)
	}
}

func TestPoolDirOverrideAndReadDoesNotWrite(t *testing.T) {
	dir := poolTestDir(t)
	if got, err := PoolDir(); err != nil || got != dir {
		t.Fatalf("PoolDir 未认 CFPILOT_CONFIG_DIR：got=%q err=%v", got, err)
	}
	path, err := PoolPath()
	if err != nil || filepath.Base(path) != PoolFilename {
		t.Fatalf("PoolPath 不对：got=%q err=%v", path, err)
	}
	if got := ReadPoolRaw(); got != "" {
		t.Fatalf("不存在的池应读成空串，实际 %q", got)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("只读不应产生文件，实际 err=%v", err)
	}
}

// ------------------------------------------------------------------
// 合法性与 CF 段判定
// ------------------------------------------------------------------

func TestPoolNormalizeCandidateKey(t *testing.T) {
	cases := []struct {
		ip   string
		port int
		want string
		ok   bool
	}{
		{"104.16.0.1", 443, "104.16.0.1:443", true},
		{" 104.16.0.1 ", 8443, "104.16.0.1:8443", true},
		{"2606:4700::1", 443, "[2606:4700::1]:443", true},
		{"999.999.999.999", 443, "", false},
		{"example.com", 443, "", false},
		{"104.16.0.1", 0, "", false},
		{"104.16.0.1", 65536, "", false},
	}
	for _, c := range cases {
		got, ok := NormalizeCandidateKey(c.ip, c.port)
		if got != c.want || ok != c.ok {
			t.Errorf("NormalizeCandidateKey(%q,%d) = (%q,%v)，期望 (%q,%v)",
				c.ip, c.port, got, ok, c.want, c.ok)
		}
	}
}

func TestPoolIsCloudflareEntryIP(t *testing.T) {
	for _, ip := range []string{"104.16.0.1", "172.64.0.1", "2606:4700::1"} {
		if !IsCloudflareEntryIP(ip) {
			t.Errorf("%s 应落在 CF 官方段内", ip)
		}
	}
	// 公共 DNS / 其它 ASN / 保留地址绝不能作为入口候选
	for _, ip := range []string{"223.5.5.5", "1.1.1.1", "8.8.8.8", "192.168.1.1", "127.0.0.1", "10.0.0.1", "::1"} {
		if IsCloudflareEntryIP(ip) {
			t.Errorf("%s 不是 CF 官方段，不该放行", ip)
		}
	}
}

// ------------------------------------------------------------------
// 合并语义
// ------------------------------------------------------------------

func TestPoolUpsertMultiSourceKeepsAllSources(t *testing.T) {
	poolTestDir(t)
	pool := EmptyPool()
	r1 := UpsertCandidates(pool, []CandidateInput{
		candidate("104.16.0.1", "github_best_cf_ips"),
	}, testNow, PoolMaxCandidates)
	r2 := UpsertCandidates(pool, []CandidateInput{
		candidate("104.16.0.1", "custom_001"),
		candidate("104.16.0.1", "custom_001"), // 同一来源重复
	}, testNow+1, PoolMaxCandidates)
	if r1.Added != 1 || r2.Added != 0 || r2.Updated != 2 {
		t.Fatalf("计数不对：r1=%+v r2=%+v", r1, r2)
	}
	if len(pool.Candidates) != 1 {
		t.Fatalf("同一 ip:port 必须只有一条，实际 %d", len(pool.Candidates))
	}
	c := pool.Candidates[0]
	if c.Key != "104.16.0.1:443" || c.FirstSeen != testNow || c.LastSeen != testNow+1 {
		t.Fatalf("key / 时间戳不对：%+v", c)
	}
	if len(c.Sources) != 2 || c.Sources[0] != "github_best_cf_ips" || c.Sources[1] != "custom_001" {
		t.Fatalf("sources 必须保留全部来源且不重复：%v", c.Sources)
	}
}

func TestPoolUpsertRejectsInvalidAndForeign(t *testing.T) {
	poolTestDir(t)
	pool := EmptyPool()
	badPort := 0
	inputs := []CandidateInput{
		candidate("999.999.999.999", "src"),
		candidate("example.com", "src"),
		{IP: "104.16.0.1", Port: &badPort, Source: "src"},
		candidate("223.5.5.5", "src"), // 公共 DNS，不是 CF 段
		candidate("8.8.8.8", "src"),
		{IP: "104.16.0.2", Source: "src", CandidateType: "proxy_ip"},
		{IP: "104.16.0.3", Source: "src", CandidateType: "nat64"},
	}
	r := UpsertCandidates(pool, inputs, testNow, PoolMaxCandidates)
	if len(pool.Candidates) != 0 || r.Added != 0 || r.Rejected != len(inputs) {
		t.Fatalf("非法候选全部应拒绝：%+v / %+v", r, pool.Candidates)
	}
	if r.Reasons["invalidIp"] != 3 || r.Reasons["notCloudflare"] != 2 || r.Reasons["candidateType"] != 2 {
		t.Fatalf("拒绝原因分类不对：%v", r.Reasons)
	}
}

func TestPoolUpsertIPv6(t *testing.T) {
	poolTestDir(t)
	pool := EmptyPool()
	r := UpsertCandidates(pool, []CandidateInput{
		candidate("2606:4700::1", "src"),
	}, testNow, PoolMaxCandidates)
	if r.Added != 1 {
		t.Fatalf("官方 IPv6 段应可入池：%+v", r)
	}
	c := pool.Candidates[0]
	if c.Key != "[2606:4700::1]:443" || c.IPVersion != 6 || c.CandidateType != EntryIP {
		t.Fatalf("IPv6 条目不对：%+v", c)
	}
	if c.Status != StatusPending || c.FullTest != nil {
		t.Fatal("新候选必须是 pending 且 fullTest=null")
	}
}

func TestPoolLightCheckDoesNotMakeActive(t *testing.T) {
	poolTestDir(t)
	pool := EmptyPool()
	lc := &LightCheck{TCPOk: true, TLSOk: true, At: testNow}
	UpsertCandidates(pool, []CandidateInput{
		{IP: "104.16.0.1", Source: "src", LightCheck: lc},
	}, testNow, PoolMaxCandidates)
	if pool.Candidates[0].Status == StatusActive {
		t.Fatal("轻量校验通过不能自动置 active —— active 只能来自 Phase 4 完整优选")
	}
	if pool.Candidates[0].LightCheck == nil || pool.Candidates[0].LightCheck.TLSMs != nil {
		t.Fatal("lightCheck 应被写入，且未传 tlsMs 时字段应整个消失（omitempty）")
	}
}

func TestPoolDisabledNotOverwrittenByRefresh(t *testing.T) {
	poolTestDir(t)
	pool := EmptyPool()
	UpsertCandidates(pool, []CandidateInput{candidate("104.16.0.1", "src")}, testNow, PoolMaxCandidates)
	pool.Candidates[0].Status = StatusDisabled
	UpsertCandidates(pool, []CandidateInput{candidate("104.16.0.1", "src2")}, testNow+100, PoolMaxCandidates)
	c := pool.Candidates[0]
	if c.Status != StatusDisabled {
		t.Fatalf("disabled 被自动刷新覆盖了：%s", c.Status)
	}
	if len(c.Sources) != 2 || c.LastSeen != testNow+100 {
		t.Fatalf("disabled 仍应合并来源/刷新时间：%+v", c)
	}
}

func TestPoolExpiredAndFailedReturnToPending(t *testing.T) {
	poolTestDir(t)
	for _, st := range []CandidateStatus{StatusExpired, StatusFailed} {
		pool := EmptyPool()
		UpsertCandidates(pool, []CandidateInput{candidate("104.16.0.1", "src")}, testNow, PoolMaxCandidates)
		pool.Candidates[0].Status = st
		UpsertCandidates(pool, []CandidateInput{candidate("104.16.0.1", "src")}, testNow+1, PoolMaxCandidates)
		if pool.Candidates[0].Status != StatusPending {
			t.Errorf("%s 被重新发现后应回到 pending，实际 %s", st, pool.Candidates[0].Status)
		}
	}
}

func TestPoolExpireMarksOnlyStale(t *testing.T) {
	poolTestDir(t)
	stale := ExternalCandidate{
		Key: "104.16.0.1:443", IP: "104.16.0.1", Port: 443, IPVersion: 4,
		CandidateType: EntryIP, Sources: []string{"src"}, LastSeen: 1, Status: StatusPending,
	}
	fresh := stale
	fresh.Key, fresh.IP, fresh.LastSeen = "104.16.0.2:443", "104.16.0.2", testNow-1000
	disabled := stale
	disabled.Key, disabled.IP, disabled.Status = "104.16.0.3:443", "104.16.0.3", StatusDisabled
	pool := &ExternalPool{Schema: PoolSchema, Candidates: []ExternalCandidate{stale, fresh, disabled}}

	UpsertCandidates(pool, nil, testNow, PoolMaxCandidates)
	if pool.Candidates[0].Status != StatusExpired {
		t.Errorf("超过 30 天未重新发现应标记 expired，实际 %s", pool.Candidates[0].Status)
	}
	if pool.Candidates[1].Status != StatusPending {
		t.Errorf("近期候选不该过期，实际 %s", pool.Candidates[1].Status)
	}
	if pool.Candidates[2].Status != StatusDisabled {
		t.Errorf("disabled 不参与过期判定，实际 %s", pool.Candidates[2].Status)
	}
	if len(pool.Candidates) != 3 {
		t.Fatal("过期只标记，不物理删除")
	}
}

func TestPoolCapacityEvictionKeepsNewestAndDisabled(t *testing.T) {
	poolTestDir(t)
	pool := EmptyPool()
	for i := 1; i <= 6; i++ {
		pool.Candidates = append(pool.Candidates, ExternalCandidate{
			Key: fmt.Sprintf("104.16.0.%d:443", i), IP: fmt.Sprintf("104.16.0.%d", i),
			Port: 443, IPVersion: 4, CandidateType: EntryIP, Sources: []string{"src"},
			FirstSeen: testNow, LastSeen: testNow + int64(i), Status: StatusPending,
		})
	}
	pool.Candidates[0].Status = StatusDisabled // 最旧的一条被用户禁用
	r := UpsertCandidates(pool, nil, testNow+10, 3)
	if len(pool.Candidates) != 3 {
		t.Fatalf("容量上限 3，实际 %d", len(pool.Candidates))
	}
	if r.Reasons["evicted"] != 1 {
		t.Fatalf("应记录淘汰原因：%v", r.Reasons)
	}
	if pool.Candidates[0].Status != StatusDisabled {
		t.Fatal("disabled 不能被淘汰")
	}
	for _, c := range pool.Candidates[1:] {
		if c.Key == "104.16.0.2:443" || c.Key == "104.16.0.3:443" {
			t.Fatalf("淘汰应删最旧的，却删掉了 %s", c.Key)
		}
	}
}

// ------------------------------------------------------------------
// 持久化 / 损坏降级 / 内容未变不写
// ------------------------------------------------------------------

func TestPoolWithPoolPersistsAcrossRestarts(t *testing.T) {
	dir := poolTestDir(t)
	err := WithPool(func(p *ExternalPool) error {
		UpsertCandidates(p, []CandidateInput{
			candidate("104.16.0.1", "github_best_cf_ips"),
			candidate("2606:4700::1", "custom_001"),
		}, testNow, PoolMaxCandidates)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, PoolFilename)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("池文件应已落盘：%v", err)
	}
	// 模拟进程重启：完全重新解析，不复用任何内存状态
	reloaded := ParsePool(ReadPoolRaw())
	if len(reloaded.Candidates) != 2 || reloaded.UpdatedAt != testNow {
		t.Fatalf("重启后池丢失：%+v", reloaded)
	}
	// 第二次进程继续追加，来源要合并而不是覆盖
	if err := WithPool(func(p *ExternalPool) error {
		UpsertCandidates(p, []CandidateInput{candidate("104.16.0.1", "custom_001")}, testNow+1, PoolMaxCandidates)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	final := ParsePool(ReadPoolRaw())
	if len(final.Candidates) != 2 || len(final.Candidates[0].Sources) != 2 {
		t.Fatalf("重启后追加应合并来源：%+v", final)
	}
}

func TestPoolWithPoolNoWriteWhenContentUnchanged(t *testing.T) {
	dir := poolTestDir(t)
	path := filepath.Join(dir, PoolFilename)
	if err := os.WriteFile(path, []byte(poolGolden), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := WithPool(func(p *ExternalPool) error { return nil }); err != nil {
		t.Fatal(err)
	}
	raw := ReadPoolRaw()
	if raw != poolGolden {
		t.Fatalf("回调没改内容，文件却变了：\n%s", raw)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("内容未变时不应重写文件（避免两进程交替刷新 updatedAt）")
	}
}

func TestPoolWithPoolErrorDoesNotWriteButReleasesLock(t *testing.T) {
	dir := poolTestDir(t)
	path := filepath.Join(dir, PoolFilename)
	if err := os.WriteFile(path, []byte(poolGolden), 0o600); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("模拟回调失败")
	if err := WithPool(func(p *ExternalPool) error {
		p.Candidates = nil
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("回调错误应原样返回，实际 %v", err)
	}
	if ReadPoolRaw() != poolGolden {
		t.Fatal("回调失败时不应落盘")
	}
	lock := filepath.Join(dir, PoolFilename+".lock")
	if _, err := os.Stat(lock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("回调失败也必须释放锁，实际 err=%v", err)
	}
}

func TestPoolCorruptFileBackedUpAndFallsBackToEmpty(t *testing.T) {
	dir := poolTestDir(t)
	path := filepath.Join(dir, PoolFilename)
	if err := os.WriteFile(path, []byte("{ 这不是 json"), 0o600); err != nil {
		t.Fatal(err)
	}
	pool := ParsePool(ReadPoolRaw())
	if len(pool.Candidates) != 0 || pool.Schema != PoolSchema {
		t.Fatalf("损坏文件应降级为空池：%+v", pool)
	}
	matches, err := filepath.Glob(path + ".corrupt-*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("损坏文件必须保留一份备份，matches=%v err=%v", matches, err)
	}
	backed, err := os.ReadFile(matches[0])
	if err != nil || string(backed) != "{ 这不是 json" {
		t.Fatalf("备份内容不对：%q err=%v", string(backed), err)
	}
	// 真正写入时才生成新的空池文件
	if err := WritePoolAtomic(mustSerialize(t, EmptyPool())); err != nil {
		t.Fatal(err)
	}
	if pool := ParsePool(ReadPoolRaw()); len(pool.Candidates) != 0 {
		t.Fatal("降级后写入的应是合法空池")
	}
}

func TestPoolSchemaMismatchBackedUp(t *testing.T) {
	dir := poolTestDir(t)
	path := filepath.Join(dir, PoolFilename)
	raw := `{"schema":999,"updatedAt":0,"candidates":[]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if pool := ParsePool(ReadPoolRaw()); len(pool.Candidates) != 0 {
		t.Fatal("不兼容 schema 应降级为空池")
	}
	matches, _ := filepath.Glob(path + ".corrupt-*")
	if len(matches) != 1 {
		t.Fatalf("不兼容 schema 也应备份：%v", matches)
	}
}

func TestPoolParseDropsForeignCandidateWithoutBackup(t *testing.T) {
	dir := poolTestDir(t)
	path := filepath.Join(dir, PoolFilename)
	raw := `{"schema":1,"updatedAt":1,"candidates":[
		{"key":"104.16.0.1:443","ip":"104.16.0.1","port":443,"ipVersion":4,"candidateType":"proxy_ip","sources":["src"],"firstSeen":1,"lastSeen":1,"lightCheck":null,"fullTest":null,"status":"pending","failCount":0,"successCount":0},
		{"key":"104.16.0.2:443","ip":"104.16.0.2","port":443,"ipVersion":4,"candidateType":"entry_ip","sources":["src"],"firstSeen":1,"lastSeen":1,"lightCheck":null,"fullTest":null,"status":"pending","failCount":0,"successCount":0}
	]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	pool := ParsePool(ReadPoolRaw())
	if len(pool.Candidates) != 1 || pool.Candidates[0].Key != "104.16.0.2:443" {
		t.Fatalf("异类型条目应被隔离丢弃：%+v", pool.Candidates)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("schema 合法时不能备份整个文件")
	}
}

func mustSerialize(t *testing.T, p *ExternalPool) string {
	t.Helper()
	s, err := SerializePool(p)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// ------------------------------------------------------------------
// 跨语言 / 跨进程文件锁
// ------------------------------------------------------------------

func TestPoolConcurrentWritesDoNotLoseCandidates(t *testing.T) {
	poolTestDir(t)
	const n = 12
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ip := fmt.Sprintf("104.16.1.%d", i+1)
			errs <- WithPool(func(p *ExternalPool) error {
				UpsertCandidates(p, []CandidateInput{candidate(ip, "src")}, testNow+int64(i), PoolMaxCandidates)
				return nil
			})
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("并发写失败：%v", err)
		}
	}
	pool := ParsePool(ReadPoolRaw())
	if len(pool.Candidates) != n {
		t.Fatalf("并发写丢了候选：期望 %d，实际 %d", n, len(pool.Candidates))
	}
	if _, err := PoolLockPath(); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(mustPoolDir(t), PoolFilename+".lock")
	if _, err := os.Stat(lock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("全部写完后锁必须已释放，实际 err=%v", err)
	}
}

func mustPoolDir(t *testing.T) string {
	t.Helper()
	d, err := PoolDir()
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPoolStaleLockIsCleaned(t *testing.T) {
	dir := poolTestDir(t)
	lock := filepath.Join(dir, PoolFilename+".lock")
	if err := os.WriteFile(lock, []byte(`{"pid":1,"at":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(lock, past, past); err != nil {
		t.Fatal(err)
	}
	if err := AcquirePoolLock(); err != nil {
		t.Fatalf("超过 30s 的陈旧锁应可清理：%v", err)
	}
	ReleasePoolLock()
}

func TestPoolLockTimeoutWhenHeldByAnotherProcess(t *testing.T) {
	dir := poolTestDir(t)
	old := lockTimeoutMS
	lockTimeoutMS = 60 // 只在本用例把 5s 压到 60ms
	defer func() { lockTimeoutMS = old }()

	lock := filepath.Join(dir, PoolFilename+".lock")
	f, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	defer os.Remove(lock)

	err = AcquirePoolLock()
	if err == nil || !strings.Contains(err.Error(), "锁超时") {
		t.Fatalf("对方持锁时应超时报错，实际 %v", err)
	}
	if _, statErr := os.Stat(lock); statErr != nil {
		t.Fatal("超时不能偷偷删掉别人的锁")
	}
}
