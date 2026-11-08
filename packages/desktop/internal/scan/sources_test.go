package scan

// Phase 2/3 回归：数据源配置契约、清单解析、SSRF、采集编排、轻量校验。
//
// sourcesGolden 与 packages/cli/test/external-sources.test.ts 的
// SOURCES_GOLDEN **必须逐字节相同**：两端各自断言 parse → serialize 往返不变。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const sourcesGolden = `{
  "schema": 2,
  "updatedAt": 1794000000000,
  "sources": [
    {
      "id": "github_ips",
      "name": "github_ips",
      "type": "github-raw",
      "url": "https://raw.githubusercontent.com/owner/repo/main/ips.txt",
      "mirrors": [
        "https://mirror.example.com/ips.txt"
      ],
      "enabled": true,
      "intervalHours": 12,
      "etag": "W/\"abc\"",
      "lastModified": "Wed, 01 Jan 2026 00:00:00 GMT",
      "lastSyncAt": 1794000000000,
      "lastError": "",
      "failCount": 0,
      "query": "",
      "maxResults": 200
    }
  ],
  "runs": [
    {
      "at": 1794000000000,
      "sourceId": "github_ips",
      "ok": true,
      "added": 3,
      "updated": 0,
      "rejected": 0,
      "error": "",
      "durationMs": 42,
      "notModified": false
    }
  ]
}
`

const sourcesNow = int64(1794000000000)

func sourcesTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CFPILOT_CONFIG_DIR", dir)
	return dir
}

func githubTestSource() SourceConfig {
	return MakeSource("github_ips", "", SourceTypeGitHubRaw,
		"https://raw.githubusercontent.com/owner/repo/main/ips.txt", nil, true, 12)
}

func customTestSource() SourceConfig {
	return MakeSource("custom_001", "", SourceTypeCustomURL,
		"https://example.com/ips.txt", nil, true, 24)
}

// ------------------------------------------------------------------
// 配置契约
// ------------------------------------------------------------------

func TestSourcesGoldenRoundTrip(t *testing.T) {
	sourcesTestDir(t)
	cfg := ParseSources(sourcesGolden)
	if len(cfg.Sources) != 1 || len(cfg.Runs) != 1 {
		t.Fatalf("golden 解析不完整：sources=%d runs=%d", len(cfg.Sources), len(cfg.Runs))
	}
	got, err := SerializeSources(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got != sourcesGolden {
		t.Fatalf("parse → serialize 往返改变了字节：\n--- got ---\n%s\n--- want ---\n%s", got, sourcesGolden)
	}
}

func TestSourcesEmptySerialization(t *testing.T) {
	sourcesTestDir(t)
	got, err := SerializeSources(EmptySources())
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"schema\": 2,\n  \"updatedAt\": 0,\n  \"sources\": [],\n  \"runs\": []\n}\n"
	if got != want {
		t.Fatalf("空配置必须输出两个 []：\ngot  %q\nwant %q", got, want)
	}
}

func TestSourcesCorruptBackedUp(t *testing.T) {
	dir := sourcesTestDir(t)
	path, _ := SourcesPath()
	if err := os.WriteFile(path, []byte("{ 不是 json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if cfg := ParseSources(ReadSourcesRaw()); len(cfg.Sources) != 0 {
		t.Fatal("损坏配置应降级为空")
	}
	matches, err := filepath.Glob(filepath.Join(dir, SourcesFilename+".corrupt-*"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("损坏配置应保留一份备份：matches=%v err=%v", matches, err)
	}
}

func TestSourcesConfigPersistsAcrossRestarts(t *testing.T) {
	sourcesTestDir(t)
	if err := WithSources(func(cfg *SourcesFile) error {
		cfg.Sources = append(cfg.Sources, githubTestSource(), customTestSource())
		AppendRun(cfg, SyncRun{At: sourcesNow, SourceID: "github_ips", OK: true, Added: 3})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// 模拟进程重启：完全重新解析
	cfg := LoadSources()
	if len(cfg.Sources) != 2 || len(cfg.Runs) != 1 {
		t.Fatalf("重启后配置丢失：%+v", cfg)
	}
	if cfg.Sources[0].IntervalHours != 12 || cfg.Sources[1].IntervalHours != 24 {
		t.Fatalf("默认间隔不对：%+v", cfg.Sources)
	}
}

// ------------------------------------------------------------------
// SSRF 与 URL 脱敏
// ------------------------------------------------------------------

func TestValidateSourceURL(t *testing.T) {
	good := []string{
		"https://example.com/ips.txt", "https://raw.githubusercontent.com/a/b/main/ips.txt",
	}
	for _, raw := range good {
		if _, err := ValidateSourceURL(raw, false); err != nil {
			t.Errorf("%s 应放行：%v", raw, err)
		}
	}
	bad := []string{
		"http://example.com/a", "file:///etc/passwd", "https://localhost/a",
		"https://x.localhost/a", "https://x.internal/a", "https://metadata.google.internal/latest",
		"https://127.0.0.1/a", "https://10.1.2.3/a", "https://172.16.5.4/a",
		"https://192.168.1.1/a", "https://169.254.169.254/latest/meta-data",
		"https://100.64.1.2/a", "https://224.0.0.1/a", "https://[::1]/a",
		"https://[fd00::1]/a", "https://[fe80::1]/a",
		"https://public.example.com@127.0.0.1/a", "https://user:pw@example.com/a",
	}
	for _, raw := range bad {
		if _, err := ValidateSourceURL(raw, false); err == nil {
			t.Errorf("%s 必须被拒绝", raw)
		}
	}
	if _, err := ValidateSourceURL("http://example.com/a", true); err != nil {
		t.Errorf("allowHTTP 应放行公网 http：%v", err)
	}
	if _, err := ValidateSourceURL("http://127.0.0.1/a", true); err == nil {
		t.Error("allowHTTP 不能放开私网判定")
	}
}

func TestSanitizeURL(t *testing.T) {
	if got := SanitizeURL("https://example.com/ips.txt?token=SECRET#x"); strings.Contains(got, "SECRET") {
		t.Fatalf("URL 未脱敏：%s", got)
	}
}

// ------------------------------------------------------------------
// 清单归一
// ------------------------------------------------------------------

func TestParseSourcePayloadTextAndPorts(t *testing.T) {
	out := ParseSourcePayload("104.16.0.1:8443\n104.16.0.2\n[2606:4700::1]:2053")
	if len(out) != 3 {
		t.Fatalf("应有 3 条，实际 %d", len(out))
	}
	if out[0].IP != "104.16.0.1" || out[0].Port == nil || *out[0].Port != 8443 {
		t.Fatalf("IPv4:port 端口丢失：%+v", out[0])
	}
	if out[1].Port != nil {
		t.Fatalf("裸 IP 不该带端口：%+v", out[1])
	}
	if out[2].IP != "2606:4700::1" || out[2].Port == nil || *out[2].Port != 2053 {
		t.Fatalf("[IPv6]:port 解析失败：%+v", out[2])
	}
}

func TestParseSourcePayloadCSV(t *testing.T) {
	out := ParseSourcePayload("No,Proxy IP,Port,City\n1,104.16.0.1,8443,LAX\n2,104.16.0.2,443,AMS")
	if len(out) != 2 {
		t.Fatalf("CSV 应解析出 2 条，实际 %d：%+v", len(out), out)
	}
	if out[0].Port == nil || *out[0].Port != 8443 {
		t.Fatalf("CSV 端口列没被识别：%+v", out[0])
	}
}

func TestParseSourcePayloadJSON(t *testing.T) {
	out := ParseSourcePayload(`["104.16.0.1:8443","104.16.0.2"]`)
	if len(out) != 2 || out[0].Port == nil || *out[0].Port != 8443 {
		t.Fatalf("JSON 数组解析失败：%+v", out)
	}
	out = ParseSourcePayload(`{"ips":[{"ip":"104.16.0.1","port":2053},{"address":"104.16.0.2"}]}`)
	if len(out) != 2 || out[0].Port == nil || *out[0].Port != 2053 {
		t.Fatalf("JSON 对象解析失败：%+v", out)
	}
}

// ------------------------------------------------------------------
// 采集编排
// ------------------------------------------------------------------

func okFetch(text string) func(context.Context, SourceConfig, SourceFetchOptions) (SourceFetchResult, error) {
	return func(_ context.Context, s SourceConfig, _ SourceFetchOptions) (SourceFetchResult, error) {
		return SourceFetchResult{Text: text, URL: SanitizeURL(s.URL)}, nil
	}
}

func TestSyncSourcesSingleFailureIsolated(t *testing.T) {
	sourcesTestDir(t)
	if err := SaveSources(&SourcesFile{
		Schema: SourcesSchema, Sources: []SourceConfig{githubTestSource(), customTestSource()}, Runs: []SyncRun{},
	}); err != nil {
		t.Fatal(err)
	}
	// 先放一条已有候选，验证失败源不清空池
	if err := WithPool(func(p *ExternalPool) error {
		UpsertCandidates(p, []CandidateInput{{IP: "104.16.0.9", Source: "seed"}}, sourcesNow, PoolMaxCandidates)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	report := SyncSources(SyncOptions{
		Now: sourcesNow + 1,
		Fetch: func(_ context.Context, s SourceConfig, o SourceFetchOptions) (SourceFetchResult, error) {
			if s.ID == "github_ips" {
				return SourceFetchResult{}, errTest("主站 404")
			}
			return okFetch("104.16.0.1\n104.16.0.2")(context.Background(), s, o)
		},
	})
	if len(report.Outcomes) != 2 {
		t.Fatalf("应有 2 个源结果：%+v", report.Outcomes)
	}
	okCount := 0
	for _, o := range report.Outcomes {
		if o.OK {
			okCount++
		}
	}
	if okCount != 1 {
		t.Fatalf("单源失败不该拖累其它源：%+v", report.Outcomes)
	}
	pool := ParsePool(ReadPoolRaw())
	if len(pool.Candidates) != 3 {
		t.Fatalf("已有候选被清空了：%+v", pool.Candidates)
	}
	cfg := LoadSources()
	for _, s := range cfg.Sources {
		if s.ID == "github_ips" && (s.FailCount != 1 || !strings.Contains(s.LastError, "404")) {
			t.Fatalf("失败原因没记进配置：%+v", s)
		}
	}
	if len(cfg.Runs) != 2 {
		t.Fatalf("每个源都应留一条采集记录：%d", len(cfg.Runs))
	}
}

func TestSyncSourcesNotModifiedDoesNotWritePool(t *testing.T) {
	sourcesTestDir(t)
	if err := SaveSources(&SourcesFile{
		Schema: SourcesSchema, Sources: []SourceConfig{customTestSource()}, Runs: []SyncRun{},
	}); err != nil {
		t.Fatal(err)
	}
	SyncSources(SyncOptions{Now: sourcesNow, Fetch: okFetch("104.16.0.1")})
	before := ReadPoolRaw()
	SyncSources(SyncOptions{
		Now: sourcesNow + 1,
		Fetch: func(_ context.Context, s SourceConfig, _ SourceFetchOptions) (SourceFetchResult, error) {
			return SourceFetchResult{URL: SanitizeURL(s.URL), NotModified: true}, nil
		},
	})
	if got := ReadPoolRaw(); got != before {
		t.Fatal("304 不该改写池文件")
	}
	cfg := LoadSources()
	if !cfg.Runs[len(cfg.Runs)-1].NotModified {
		t.Fatal("304 应记进采集记录")
	}
}

func TestSyncSourcesRejectsNonCloudflare(t *testing.T) {
	sourcesTestDir(t)
	if err := SaveSources(&SourcesFile{
		Schema: SourcesSchema, Sources: []SourceConfig{customTestSource()}, Runs: []SyncRun{},
	}); err != nil {
		t.Fatal(err)
	}
	report := SyncSources(SyncOptions{
		Now: sourcesNow, Fetch: okFetch("104.16.0.1\n223.5.5.5\n8.8.8.8"),
	})
	if len(report.Outcomes) != 1 || report.Outcomes[0].Rejected != 2 {
		t.Fatalf("非 CF 段应被拒：%+v", report.Outcomes)
	}
	if len(ParsePool(ReadPoolRaw()).Candidates) != 1 {
		t.Fatal("池里只应有 1 条 CF 官方段候选")
	}
}

func TestRemoveSourceKeepsSharedCandidates(t *testing.T) {
	sourcesTestDir(t)
	if err := SaveSources(&SourcesFile{
		Schema: SourcesSchema, Runs: []SyncRun{},
		Sources: []SourceConfig{
			customTestSource(),
			MakeSource("s2", "", SourceTypeCustomURL, "https://b.example.com/a.txt", nil, true, 24),
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := WithPool(func(p *ExternalPool) error {
		UpsertCandidates(p, []CandidateInput{
			{IP: "104.16.0.1", Source: "custom_001"},
			{IP: "104.16.0.1", Source: "s2"}, // 同一 IP 两个来源
			{IP: "104.16.0.2", Source: "custom_001"},
		}, sourcesNow, PoolMaxCandidates)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	removed, kept, err := RemoveSource("custom_001")
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 || kept != 1 {
		t.Fatalf("只应删掉无其它来源引用的候选：removed=%d kept=%d", removed, kept)
	}
	c := ParsePool(ReadPoolRaw()).Candidates
	if len(c) != 1 || len(c[0].Sources) != 1 || c[0].Sources[0] != "s2" {
		t.Fatalf("共享候选应保留且关联已清理：%+v", c)
	}
	if len(LoadSources().Sources) != 1 {
		t.Fatal("配置里的源没删掉")
	}
}

func TestRemoveSourceKeepsDisabledCandidates(t *testing.T) {
	sourcesTestDir(t)
	if err := WithSources(func(cfg *SourcesFile) error {
		cfg.Sources = append(cfg.Sources, customTestSource())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := WithPool(func(p *ExternalPool) error {
		UpsertCandidates(p, []CandidateInput{{IP: "104.16.0.1", Source: "custom_001"}}, sourcesNow, PoolMaxCandidates)
		p.Candidates[0].Status = StatusDisabled
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	removed, kept, err := RemoveSource("custom_001")
	if err != nil || removed != 0 || kept != 1 {
		t.Fatalf("用户禁用的候选不该被删：removed=%d kept=%d err=%v", removed, kept, err)
	}
}

// ------------------------------------------------------------------
// 轻量校验（Phase 3）
// ------------------------------------------------------------------

func TestLightCheckCandidates(t *testing.T) {
	sourcesTestDir(t)
	inputs := []CandidateInput{{IP: "104.16.0.1", Source: "s"}, {IP: "104.16.0.2", Source: "s"}}
	out := LightCheckCandidates(context.Background(), inputs, LightCheckOptions{
		Now: sourcesNow, SNI: "cloudflare.com",
		TCPProbe: func(_ context.Context, ip string, _ int, _ time.Duration) bool {
			return ip == "104.16.0.1"
		},
		TLSProbe: func(_ context.Context, _ string, _ int, _ string, _ time.Duration) (bool, int64) {
			return true, 12
		},
	})
	if out[0].LightCheck == nil || !out[0].LightCheck.TCPOk || !out[0].LightCheck.TLSOk {
		t.Fatalf("第一条应通过：%+v", out[0].LightCheck)
	}
	if out[0].LightCheck.TLSMs == nil || *out[0].LightCheck.TLSMs != 12 {
		t.Fatalf("tlsMs 没写：%+v", out[0].LightCheck)
	}
	if out[1].LightCheck == nil || out[1].LightCheck.TCPOk || out[1].LightCheck.TLSOk {
		t.Fatalf("第二条应记为失败但仍保留：%+v", out[1].LightCheck)
	}
}

func TestLightCheckCandidatesMaxPerSync(t *testing.T) {
	sourcesTestDir(t)
	var inputs []CandidateInput
	for i := 1; i <= 10; i++ {
		inputs = append(inputs, CandidateInput{IP: fmt.Sprintf("104.16.0.%d", i), Source: "s"})
	}
	out := LightCheckCandidates(context.Background(), inputs, LightCheckOptions{
		Now: sourcesNow, MaxPerSync: 3, Concurrency: 2,
		TCPProbe: func(_ context.Context, _ string, _ int, _ time.Duration) bool { return true },
		TLSProbe: func(_ context.Context, _ string, _ int, _ string, _ time.Duration) (bool, int64) { return true, 5 },
	})
	checked := 0
	for _, c := range out {
		if c.LightCheck != nil {
			checked++
		}
	}
	if checked != 3 {
		t.Fatalf("数量闸门没生效：校验了 %d 条", checked)
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }
