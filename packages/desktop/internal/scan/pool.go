package scan

// 外部 IP 候选池（CLI / 桌面版共用一份本地文件）。
//
// ## 为什么是本地池，不是 KV
//
// KV 的 LOCAL_PREFERRED_IPS 是**订阅下发池**：maxNodes 默认 0，每一行都会
// 变成一个节点。外部发现的原始候选如果写进 KV，会直接把订阅撑爆，
// 而且跳过了完整优选测速。本包只负责「发现 + 轻量校验」的**入口 IP 候选**：
// 长期积累在磁盘上，用户主动跑完整优选时才从池中取样，测速通过的少量精选
// 才经现有 /preferred-ips 回填。Worker 控制面因此零改动。
//
// ## 跨语言契约（E2）—— 改这个文件前先读 packages/cli/src/sources/pool.ts
//
// 两端读写 `<configDir>/external-candidates.json`，同一 schema、同一 lockfile
// 语义、同一序列化格式（2 空格缩进 + 结尾换行、不转义 HTML）。都认
// CFPILOT_CONFIG_DIR 覆盖（测试隔离用）。
//
// ⚠️ 桌面版其它配置在 `~/.cfpilot-gui`（见 internal/config/config.go），
// 这个池刻意放在 CLI 的 `~/.cfpilot` —— 是跨版本共用的结果，不是路径写错。
//
// ## 序列化必须逐字节一致
//
// `WithPool` 用「序列化前后文本是否相同」决定要不要落盘。若 Go 与 CLI 的
// JSON 排版差一个空格，两个进程交替刷新就会无意义地反复重写同一个文件。
// 因此这里用 json.Encoder + SetIndent("", "  ") + SetEscapeHTML(false)：
// Encoder.Encode 自带结尾换行，正好等于 CLI 的
// `${JSON.stringify(pool, null, 2)}\n`。结构体字段顺序也刻意与 TS 接口一致。
//
// ## 本层不做的事
//
// 不解析外部清单（Phase 2）、不做 TCP/TLS 校验（Phase 3）、
// 不触发完整优选或回填（Phase 4）。只管持久化、去重、来源关联与状态。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// PoolSchema 是本地池文件格式版本。不兼容的 schema 会备份原文件并降级为空池。
	PoolSchema = 1
	// PoolFilename 是池文件名（CLI 侧 POOL_FILENAME）。
	PoolFilename = "external-candidates.json"
	// EntryIP 是唯一允许的候选类型；ProxyIP / NAT64 / Relay 必须独立管理。
	EntryIP = "entry_ip"

	// PoolExpireMS：30 天没有被任何来源重新发现 → 标记 expired（不物理删除）。
	PoolExpireMS = int64(30 * 24 * 60 * 60 * 1000)
	// PoolMaxCandidates：超出按 lastSeen 淘汰最旧的；disabled 不参与淘汰。
	PoolMaxCandidates = 5000

	lockStaleMS = int64(30_000)
)

// 下面两个做成变量（而非 const）只为了单测能把「锁超时」从 5s 压到几十毫秒，
// 避免测试真的干等 5 秒。生产路径不会改它们。
var (
	lockTimeoutMS = int64(5_000)
	lockRetryMS   = int64(25)
)

// CandidateStatus 与 CLI 的 CandidateStatus 逐项一致。
type CandidateStatus string

const (
	StatusPending  CandidateStatus = "pending"
	StatusActive   CandidateStatus = "active"
	StatusFailed   CandidateStatus = "failed"
	StatusDisabled CandidateStatus = "disabled"
	StatusExpired  CandidateStatus = "expired"
)

// LightCheck 是 TCP/TLS 轻量校验结果（Phase 3 写入）。
//
// TLSMs 用指针 + omitempty 对齐 CLI 的 `tlsMs?: number`：不传时字段整个消失，
// 而不是写成 null —— 否则两端序列化会差一个字段。
type LightCheck struct {
	TCPOk bool   `json:"tcpOk"`
	TLSOk bool   `json:"tlsOk"`
	TLSMs *int64 `json:"tlsMs,omitempty"`
	At    int64  `json:"at"`
}

// FullTest 是完整优选结果（Phase 4 写入）；nil 指针序列化成 JSON null。
type FullTest struct {
	At        *int64   `json:"at"`
	WSOk      *bool    `json:"wsOk"`
	SpeedMBps *float64 `json:"speedMBps"`
	Colo      *string  `json:"colo"`
}

// ExternalCandidate 的字段顺序**不能改**：它就是落盘的 JSON 字段顺序，
// 改了会让 CLI 读到的文件被重新排版，破坏「内容未变不写」。
type ExternalCandidate struct {
	Key           string          `json:"key"`
	IP            string          `json:"ip"`
	Port          int             `json:"port"`
	IPVersion     int             `json:"ipVersion"`
	CandidateType string          `json:"candidateType"`
	Sources       []string        `json:"sources"`
	FirstSeen     int64           `json:"firstSeen"`
	LastSeen      int64           `json:"lastSeen"`
	LightCheck    *LightCheck     `json:"lightCheck"`
	FullTest      *FullTest       `json:"fullTest"`
	Status        CandidateStatus `json:"status"`
	FailCount     int             `json:"failCount"`
	SuccessCount  int             `json:"successCount"`
}

// ExternalPool 是整份池文件。
type ExternalPool struct {
	Schema     int                 `json:"schema"`
	UpdatedAt  int64               `json:"updatedAt"`
	Candidates []ExternalCandidate `json:"candidates"`
}

// CandidateInput 是一次「发现」的输入。
//
// Port 用指针是为了区分「没传（默认 443）」与「显式传了 0（非法端口，拒绝）」——
// CLI 侧 `port?: number` 也是这个语义，用 int 的零值当缺省会把非法端口误收。
type CandidateInput struct {
	IP            string
	Port          *int
	Source        string
	CandidateType string // 空串 = entry_ip
	LightCheck    *LightCheck
}

// UpsertResult 是本次合并的计数与拒绝原因，便于 Phase 2 采集器出报告。
type UpsertResult struct {
	Added    int
	Updated  int
	Rejected int
	Reasons  map[string]int
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// ------------------------------------------------------------------
// 路径
// ------------------------------------------------------------------

// PoolDir 返回池目录。默认 `~/.cfpilot`，CFPILOT_CONFIG_DIR 可覆盖。
//
// 与 CLI 的 poolDir() 保持同一套覆盖规则；**每次调用都重新读环境变量**，
// 否则测试里 t.Setenv 之后已经算好的路径不会变。
func PoolDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("CFPILOT_CONFIG_DIR")); override != "" {
		return override, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("无法定位用户主目录：%w", err)
	}
	return filepath.Join(home, ".cfpilot"), nil
}

// PoolPath 返回池文件完整路径。
func PoolPath() (string, error) {
	dir, err := PoolDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, PoolFilename), nil
}

// PoolLockPath 返回跨语言 lockfile 路径（CLI 用 openSync(path,'wx')）。
func PoolLockPath() (string, error) {
	dir, err := PoolDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, PoolFilename+".lock"), nil
}

// ------------------------------------------------------------------
// 合法性与 CF 段判定（复用扫描器已有的官方段表，不重复造轮子）
// ------------------------------------------------------------------

// ipFamily 按字面量判地址族：含冒号 = IPv6。
//
// ⚠️ 用 `net.ParseIP(...).To4()` 判族会把 `::ffff:1.2.3.4` 归成 v4，
// 而 CLI 的 node:net isIP() 判它是 6。这里必须按字面量判，才与 CLI 一致。
func ipFamily(ip string) int {
	if strings.Contains(ip, ":") {
		return 6
	}
	return 4
}

// NormalizeCandidateKey 生成候选唯一键。
//
// IPv4 → `ip:port`，IPv6 → `[ip]:port`（避免 IPv6 自带冒号造成歧义）。
// 非法 IP / 非法端口返回 ok=false。
//
// ⚠️ IPv6 **不做地址压缩归一**，保留输入原样：CLI 侧同样只做 trim。
// 代价是 `2606:4700::1` 与 `2606:4700:0:0:0:0:0:1` 会是两个 key ——
// 这是已知限制，由 Phase 2 采集器在入池前统一清洗，不在本层偷偷改语义。
func NormalizeCandidateKey(ip string, port int) (string, bool) {
	clean := strings.TrimSpace(ip)
	parsed := net.ParseIP(clean)
	if parsed == nil || port < 1 || port > 65535 {
		return "", false
	}
	if ipFamily(clean) == 6 {
		if parsed.To4() != nil { // IPv4-mapped 形式不是合法入口 IPv6
			return "", false
		}
		return fmt.Sprintf("[%s]:%d", clean, port), true
	}
	if parsed.To4() == nil {
		return "", false
	}
	return fmt.Sprintf("%s:%d", clean, port), true
}

var (
	poolNetsOnce sync.Once
	poolV4Nets   []*net.IPNet
	poolV6Nets   []*net.IPNet
)

func initPoolNets() {
	poolNetsOnce.Do(func() {
		parse := func(list []string) []*net.IPNet {
			out := make([]*net.IPNet, 0, len(list))
			for _, cidr := range list {
				_, n, err := net.ParseCIDR(cidr)
				if err == nil {
					out = append(out, n)
				}
			}
			return out
		}
		poolV4Nets = parse(BuiltinIPv4CIDRs)
		poolV6Nets = parse(BuiltinIPv6CIDRs)
	})
}

// IsCloudflareEntryIP 判断 IP 是否落在 Cloudflare 官方段内。
//
// ⚠️ 口径用扫描器的官方 15 段 + IPv6 聚合段（CLI 与 Go 两表逐项一致），
// **不含** worker-core isCloudflareIpv4 的补充段（DNS / IANA 保留地址）——
// 那些本来就不该作为入口候选。
func IsCloudflareEntryIP(ip string) bool {
	clean := strings.TrimSpace(ip)
	parsed := net.ParseIP(clean)
	if parsed == nil {
		return false
	}
	initPoolNets()
	if ipFamily(clean) == 6 {
		if parsed.To4() != nil {
			return false
		}
		for _, n := range poolV6Nets {
			if n.Contains(parsed) {
				return true
			}
		}
		return false
	}
	v4 := parsed.To4()
	if v4 == nil {
		return false
	}
	for _, n := range poolV4Nets {
		if n.Contains(v4) {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------------
// 读写
// ------------------------------------------------------------------

// EmptyPool 返回空池。Candidates 必须是**非 nil 空切片**：
// nil 切片会被 json 编码成 null，而 CLI 的空池是 []，两端会不一致。
func EmptyPool() *ExternalPool {
	return &ExternalPool{
		Schema:     PoolSchema,
		UpdatedAt:  0,
		Candidates: make([]ExternalCandidate, 0),
	}
}

// ReadPoolRaw 返回原始文本（文件不存在 = 空串，绝不因为「读」就产生写入）。
func ReadPoolRaw() string {
	path, err := PoolPath()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}

// validCandidate 对齐 CLI 的 isValidCandidate 类型守卫。
//
// candidateType 是**隔离断言**：异类型条目（ProxyIP / NAT64 / Relay）
// 直接丢弃，不进池；结构损坏的条目同样丢弃。
func validCandidate(c *ExternalCandidate) bool {
	return c.Key != "" &&
		c.IP != "" &&
		c.Port >= 1 && c.Port <= 65535 &&
		(c.IPVersion == 4 || c.IPVersion == 6) &&
		c.CandidateType == EntryIP &&
		c.Sources != nil &&
		c.FirstSeen >= 0 && c.LastSeen >= 0 &&
		c.Status != ""
}

// ParsePool 解析池文本；损坏时保留备份并返回空池（下次真正写入时才落盘）。
//
// 与 CLI 一致的三个降级口径：
//  1. 空白 / 不存在 → 空池，不备份；
//  2. JSON 坏掉或 schema 不兼容 → 备份 + 空池；
//  3. candidates 不是数组、或个别条目坏掉 → **不备份**，只丢掉坏条目。
func ParsePool(raw string) *ExternalPool {
	if strings.TrimSpace(raw) == "" {
		return EmptyPool()
	}
	var env struct {
		Schema     *int            `json:"schema"`
		UpdatedAt  *int64          `json:"updatedAt"`
		Candidates json.RawMessage `json:"candidates"`
	}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return backupCorruptPool()
	}
	if env.Schema == nil || *env.Schema != PoolSchema {
		return backupCorruptPool()
	}

	out := EmptyPool()
	if env.UpdatedAt != nil {
		out.UpdatedAt = *env.UpdatedAt
	}
	// CLI 侧 `Array.isArray(obj.candidates) ? ... : []` —— 非数组不算文件损坏
	if bytes.HasPrefix(bytes.TrimSpace(env.Candidates), []byte("[")) {
		var items []json.RawMessage
		if err := json.Unmarshal(env.Candidates, &items); err == nil {
			for _, item := range items {
				var c ExternalCandidate
				if err := json.Unmarshal(item, &c); err != nil {
					continue // 单条坏掉：丢弃该条，与 CLI 的 filter 同效
				}
				if !validCandidate(&c) {
					continue
				}
				if c.Sources == nil {
					c.Sources = []string{}
				}
				out.Candidates = append(out.Candidates, c)
			}
		}
	}
	return out
}

// backupCorruptPool 把损坏文件改名保留现场，返回空池。
// 备份失败不阻断：返回空池即可。
func backupCorruptPool() *ExternalPool {
	path, err := PoolPath()
	if err != nil {
		return EmptyPool()
	}
	backup := fmt.Sprintf("%s.corrupt-%d", path, nowMillis())
	_ = os.Rename(path, backup)
	return EmptyPool()
}

// SerializePool 与 CLI 的 serializePool **逐字节一致**：
// 2 空格缩进、不转义 HTML、结尾一个换行。
func SerializePool(pool *ExternalPool) (string, error) {
	if pool == nil {
		pool = EmptyPool()
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(pool); err != nil {
		return "", fmt.Errorf("序列化本地候选池失败：%w", err)
	}
	return buf.String(), nil
}

// WritePoolAtomic 原子写：同目录临时文件 + rename，避免写一半损坏。
func WritePoolAtomic(text string) error {
	dir, err := PoolDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("无法创建配置目录 %s：%w", dir, err)
	}
	path := filepath.Join(dir, PoolFilename)
	tmp := filepath.Join(dir, fmt.Sprintf("%s.%d.%d.tmp", PoolFilename, os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(tmp, []byte(text), 0o600); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("写入本地候选池失败：%w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("替换本地候选池失败：%w", err)
	}
	return nil
}

// ------------------------------------------------------------------
// 跨语言文件锁（CLI 侧用 openSync(path,'wx')，即 O_CREATE|O_EXCL）
// ------------------------------------------------------------------

// AcquirePoolLock 抢锁；锁文件超过 30s 视为陈旧可清理，总等待 5s 后报错。
func AcquirePoolLock() error {
	dir, err := PoolDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("无法创建配置目录 %s：%w", dir, err)
	}
	lock := filepath.Join(dir, PoolFilename+".lock")
	started := nowMillis()
	for {
		f, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			payload := fmt.Sprintf(`{"pid":%d,"at":%d}`, os.Getpid(), nowMillis())
			_, werr := f.WriteString(payload)
			cerr := f.Close()
			if werr != nil {
				return werr
			}
			return cerr
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		st, statErr := os.Stat(lock)
		if statErr != nil {
			continue // 锁刚好被对方释放，下一轮重抢
		}
		if nowMillis()-st.ModTime().UnixMilli() > lockStaleMS {
			_ = os.Remove(lock)
			continue
		}
		if nowMillis()-started > lockTimeoutMS {
			return fmt.Errorf("本地候选池正被另一个进程占用（锁超时）")
		}
		time.Sleep(time.Duration(lockRetryMS) * time.Millisecond)
	}
}

// ReleasePoolLock 释放锁。与 CLI 一样无条件 unlink（锁内容不做身份校验）。
func ReleasePoolLock() {
	lock, err := PoolLockPath()
	if err != nil {
		return
	}
	_ = os.Remove(lock)
}

// WithPool 是读-改-写的唯一入口：持锁加载 → 回调修改 → 内容有变化才原子落盘。
//
// 「内容未变不写」既是省 I/O，也避免两个进程交替刷新 updatedAt 造成无意义写。
// 回调返回 error 时不落盘（与 CLI 的 await fn 抛错跳过写一致），锁仍会释放。
func WithPool(fn func(*ExternalPool) error) error {
	if err := AcquirePoolLock(); err != nil {
		return err
	}
	defer ReleasePoolLock()

	before := ReadPoolRaw()
	pool := ParsePool(before)
	if err := fn(pool); err != nil {
		return err
	}
	after, err := SerializePool(pool)
	if err != nil {
		return err
	}
	if after != before {
		return WritePoolAtomic(after)
	}
	return nil
}

// ------------------------------------------------------------------
// 合并、状态与淘汰
// ------------------------------------------------------------------

func bumpReason(reasons map[string]int, reason string) {
	reasons[reason]++
}

// UpsertCandidates 把一批新发现的候选并入池。
//
// 状态规则（对齐执行计划 §3.2 / §8.3）：
//   - 新增 → pending；active 只能由 Phase 4 的完整优选写入，本层不自动置 active
//   - 已存在 → 合并 sources、刷新 lastSeen；disabled 不被刷新覆盖
//   - expired / failed 被重新发现 → 回到 pending，允许再次验证
//
// 与 CLI 的 upsertCandidates 逐条对齐，包括 reasons 的键名与计数方式。
func UpsertCandidates(pool *ExternalPool, inputs []CandidateInput, now int64, maxCandidates int) UpsertResult {
	result := UpsertResult{Reasons: make(map[string]int)}
	byKey := make(map[string]int, len(pool.Candidates))
	for i := range pool.Candidates {
		byKey[pool.Candidates[i].Key] = i
	}

	for _, input := range inputs {
		if input.CandidateType != "" && input.CandidateType != EntryIP {
			result.Rejected++
			bumpReason(result.Reasons, "candidateType")
			continue
		}
		port := 443
		if input.Port != nil {
			port = *input.Port
		}
		key, ok := NormalizeCandidateKey(input.IP, port)
		if !ok {
			result.Rejected++
			bumpReason(result.Reasons, "invalidIp")
			continue
		}
		if !IsCloudflareEntryIP(input.IP) {
			result.Rejected++
			bumpReason(result.Reasons, "notCloudflare")
			continue
		}

		if idx, exists := byKey[key]; exists {
			c := &pool.Candidates[idx]
			found := false
			for _, s := range c.Sources {
				if s == input.Source {
					found = true
					break
				}
			}
			if !found {
				c.Sources = append(c.Sources, input.Source)
			}
			c.LastSeen = now
			switch c.Status {
			case StatusDisabled:
				// 用户手动禁用，自动刷新不能覆盖
			case StatusExpired, StatusFailed:
				c.Status = StatusPending
			}
			if input.LightCheck != nil {
				c.LightCheck = input.LightCheck
			}
			result.Updated++
			continue
		}

		created := ExternalCandidate{
			Key:           key,
			IP:            strings.TrimSpace(input.IP),
			Port:          port,
			IPVersion:     ipFamily(strings.TrimSpace(input.IP)),
			CandidateType: EntryIP,
			Sources:       []string{input.Source},
			FirstSeen:     now,
			LastSeen:      now,
			LightCheck:    input.LightCheck,
			FullTest:      nil,
			Status:        StatusPending,
			FailCount:     0,
			SuccessCount:  0,
		}
		byKey[key] = len(pool.Candidates)
		pool.Candidates = append(pool.Candidates, created)
		result.Added++
	}

	// 过期只标记、不物理删除；disabled 不参与
	for i := range pool.Candidates {
		c := &pool.Candidates[i]
		if c.Status != StatusDisabled && now-c.LastSeen > PoolExpireMS {
			c.Status = StatusExpired
		}
	}

	// 容量淘汰：按 lastSeen 从旧到新删，disabled 保留。
	// 用索引而不是指针，避免 append 扩容后指针失效。
	if len(pool.Candidates) > maxCandidates {
		type disposable struct {
			idx      int
			lastSeen int64
			key      string
		}
		list := make([]disposable, 0, len(pool.Candidates))
		for i := range pool.Candidates {
			if pool.Candidates[i].Status != StatusDisabled {
				list = append(list, disposable{i, pool.Candidates[i].LastSeen, pool.Candidates[i].Key})
			}
		}
		// CLI 的 Array.sort 是稳定排序；这里同样用 Stable，保证同 lastSeen 时顺序一致
		sort.SliceStable(list, func(a, b int) bool { return list[a].lastSeen < list[b].lastSeen })
		overflow := len(pool.Candidates) - maxCandidates
		drop := make(map[string]bool)
		for i := 0; i < overflow && i < len(list); i++ {
			drop[list[i].key] = true
		}
		if len(drop) > 0 {
			kept := make([]ExternalCandidate, 0, len(pool.Candidates)-len(drop))
			for _, c := range pool.Candidates {
				if !drop[c.Key] {
					kept = append(kept, c)
				}
			}
			pool.Candidates = kept
			bumpReason(result.Reasons, "evicted")
		}
	}

	pool.UpdatedAt = now
	return result
}
