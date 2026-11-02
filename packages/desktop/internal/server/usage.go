package server

// 账号用量与额度（只读）。
//
// ## 为什么做这个
//
// Cloudflare **不提供"剩余额度"接口**（实测 /accounts/{id}/usage 与
// /accounts/{id}/limits 都返回 10404 No route），只给"已用量"。
// 所以这里做的是：用量（GraphQL 分析接口）+ 方案上限（本地表）→ 算出剩余。
//
// ## 三重保护，避免把账号打爆
//
//  1. **缓存**：结果缓存 15 分钟，反复打开面板不重复请求；
//  2. **本地风控**：每 5 分钟最多 30 次 Cloudflare API 调用（远低于官方 1200 次），
//     达到上限就**停止调用**，只返回旧数据；
//  3. **只读**：全部是 GET / GraphQL 查询，不写任何东西，不消耗产品额度。
//
// ## 权限
//
// 需要 Account → Account Analytics → Read（GraphQL 分析接口）。
// 缺这项权限时返回明确提示，不影响其它功能。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

const (
	// usageCacheTTL 是用量快照的缓存时长。
	usageCacheTTL = 15 * time.Minute
	// usageLocalCallLimit 是本地风控：窗口内最多几次 Cloudflare API 调用。
	//
	// 官方限制是 1200 次 / 5 分钟；这里取 120 次（约十分之一），
	// 既够正常用（后台采集 + 手动刷新），又能挡住程序出 bug 时的疯狂调用。
	usageLocalCallLimit = 120
	// usageLocalCallWindow 是本地风控窗口。
	usageLocalCallWindow = 5 * time.Minute
	// usageDailyWriteLimit 是**每日 KV 写操作**的本地上限。
	//
	// Cloudflare 免费版每个账号每天 1000 次 KV 写，
	// 这里取官方上限的**十分之一**（100 次/天）。
	// 写配额用光的后果比读严重得多：回填与面板保存会直接 500。
	usageDailyWriteLimit = 100
	// usageGraphQLPath 是 GraphQL 分析接口路径。
	//
	// ⚠️ cfapi.DefaultAPIBase 已经含 /client/v4，所以这里不带前缀。
	usageGraphQLPath = "/graphql"
)

// usageLimits 是一天的额度上限（按套餐）。
//
// 数值来自官方限额表（Workers / KV 的 Free 与 Paid 对照）。
// 0 表示该套餐无上限。
type usageLimits struct {
	Plan               string `json:"plan"`
	PlanName           string `json:"planName,omitempty"`
	WorkersRequests    int64  `json:"workersRequests"`
	KVReads            int64  `json:"kvReads"`
	KVWrites           int64  `json:"kvWrites"`
	KVStorageBytes     int64  `json:"kvStorageBytes"`
	UnlimitedWorkers   bool   `json:"unlimitedWorkers"`
	UnlimitedKVOps     bool   `json:"unlimitedKvOps"`
	UnlimitedKVStorage bool   `json:"unlimitedKvStorage"`
}

// freeUsageLimits 是 Cloudflare Free 套餐的日上限。
//
//	Workers 请求：100,000 / 天（UTC 0 点重置，超限返回 1027）
//	KV 读：100,000 / 天；KV 写：1,000 / 天；KV 存储：1 GB / 账号
func freeUsageLimits() usageLimits {
	return usageLimits{
		Plan:            "free",
		WorkersRequests: 100000,
		KVReads:         100000,
		KVWrites:        1000,
		KVStorageBytes:  1 << 30,
	}
}

// paidUsageLimits 是 Paid 套餐：请求与读写无上限，存储也无上限。
func paidUsageLimits() usageLimits {
	return usageLimits{
		Plan:               "paid",
		UnlimitedWorkers:   true,
		UnlimitedKVOps:     true,
		UnlimitedKVStorage: true,
	}
}

// usagePoint 是某一天的用量。
type usagePoint struct {
	WorkersRequests int64 `json:"workersRequests"`
	KVReads         int64 `json:"kvReads"`
	KVWrites        int64 `json:"kvWrites"`
	KVDeletes       int64 `json:"kvDeletes"`
	WorkersErrors   int64 `json:"workersErrors"`
	WorkersSubreq   int64 `json:"workersSubrequests"`
}

// usageScript 是单个 Worker 脚本的用量。
type usageScript struct {
	Name     string `json:"name"`
	Requests int64  `json:"requests"`
	Errors   int64  `json:"errors"`
	// CFPilot 为 true 表示这是本工具部署的实例。
	CFPilot bool `json:"cfpilot,omitempty"`
}

// usageRatelimit 是 API 调用速率限制的状态。
type usageRatelimit struct {
	// RemoteRemaining 是官方响应头给出的剩余调用次数。
	RemoteRemaining int `json:"remoteRemaining"`
	// RemoteLimit 是官方窗口内的总配额。
	RemoteLimit int `json:"remoteLimit"`
	// RemoteWindowSec 是窗口长度（秒）。
	RemoteWindowSec int `json:"remoteWindowSec"`
	// LocalRemaining 是本地风控的剩余次数。
	LocalRemaining int `json:"localRemaining"`
	// LocalLimit 是本地风控的窗口配额。
	LocalLimit int `json:"localLimit"`
	// LocalBlocked 为 true 表示本地风控已拦截，本轮没有真正发起调用。
	LocalBlocked bool `json:"localBlocked"`
	// LocalWindowSec 是本地风控窗口长度（秒）。
	LocalWindowSec int `json:"localWindowSec"`
}

// usageStorage 是 KV 存储占用。
type usageStorage struct {
	Bytes    int64 `json:"bytes"`
	KeyCount int64 `json:"keyCount"`
}

// usageInstance 是账号里的一个部署实例。
//
// ## 为什么需要它
//
// 用量统计来自 Workers 分析数据集 —— **只包含 Worker，不包含 Pages**。
// CFPilot 的控制面与数据面默认都是 **Pages 项目**，
// 它们的调用根本不在这张表里。
//
// 不说清楚的话，界面上的「8416 次请求」会被误读成"CFPilot 数据面的消耗"，
// 而那其实是账号里**别的** Worker。
type usageInstance struct {
	// Name 是项目名 / 脚本名。
	Name string `json:"name"`
	// Kind 是 "pages"（不计入 Workers 统计）或 "worker"（计入）。
	Kind string `json:"kind"`
	// CFPilot 为 true 表示这是本工具部署的实例。
	CFPilot bool `json:"cfpilot"`
}

// usageSnapshot 是一次用量查询的结果。
type usageSnapshot struct {
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
	Plan        string `json:"plan,omitempty"`
	GeneratedAt string `json:"generatedAt,omitempty"`
	// Stale 为 true 表示这份数据不是本次刷新的（被风控或缓存兜底）。
	Stale bool `json:"stale"`
	// Throttled 为 true 表示本地风控拦截了本次刷新。
	Throttled bool `json:"throttled"`
	// Notice 是给用户的一句话说明。
	Notice string `json:"notice,omitempty"`
	// TTLSec 是缓存时长（秒），界面据此提示"多久后可刷新"。
	TTLSec int `json:"ttlSec"`
	// NextRefreshAt 是下次允许刷新的时间。
	NextRefreshAt string `json:"nextRefreshAt,omitempty"`

	Limits    usageLimits    `json:"limits"`
	Ratelimit usageRatelimit `json:"ratelimit"`

	// Days 是折线图的时间轴（UTC 日期，最近的在最后）。
	Days []string `json:"days"`
	// Series 是与 Days 对齐的每日用量。
	Series []usagePoint `json:"series"`

	Today     usagePoint   `json:"today"`
	Yesterday usagePoint   `json:"yesterday"`
	Average   usagePoint   `json:"average"`
	Storage   usageStorage `json:"storage"`
	// StatusCounts 是调用状态分布（success / exceededResources / loadShed …）。
	StatusCounts map[string]int64 `json:"statusCounts"`
	// StatusByScript 是「每个脚本 × 每种状态」的次数（悬浮提示用）。
	StatusByScript map[string]map[string]int64 `json:"statusByScript"`
	// Scripts 是按请求数排序的脚本消耗（前若干个）。
	Scripts []usageScript `json:"scripts"`
	// DailyWriteUsed / DailyWriteLimit 是本地 KV 写配额日风控的用量与上限。
	DailyWriteUsed  int `json:"dailyWriteUsed"`
	DailyWriteLimit int `json:"dailyWriteLimit"`
	// Instances 是账号里的部署实例（Pages / Worker），标出哪些是本工具的。
	Instances []usageInstance `json:"instances"`
	// CFPilotWorkerRequests 是属于本工具 Worker 的请求数（Pages 形态则为 0）。
	CFPilotWorkerRequests int64 `json:"cfpilotWorkerRequests"`
	// ScopeNote 说明这份统计的覆盖范围（避免误读成"CFPilot 自己的消耗"）。
	ScopeNote string `json:"scopeNote,omitempty"`
}

// usageGuard 是本地的 API 调用风控。
//
// 为什么必须有：本地程序出 bug（比如定时器重复触发）时，
// 可能在一分钟内打出成百上千次请求，把账号的 API 配额打光、
// 甚至触发平台风控。达到本地阈值就**不再发起调用**。
type usageGuard struct {
	mu     sync.Mutex
	calls  []time.Time
	limit  int
	window time.Duration
}

// newUsageGuard 构造一个风控器。
func newUsageGuard(limit int, window time.Duration) *usageGuard {
	return &usageGuard{limit: limit, window: window}
}

// allow 判断现在能不能发起调用，并返回窗口内的剩余次数。
func (g *usageGuard) allow(now time.Time) (bool, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.prune(now)
	remaining := g.limit - len(g.calls)
	if remaining < 0 {
		remaining = 0
	}
	return remaining > 0, remaining
}

// record 记录一次调用。
func (g *usageGuard) record(now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.prune(now)
	g.calls = append(g.calls, now)
}

// prune 丢弃窗口外的记录。
func (g *usageGuard) prune(now time.Time) {
	cutoff := now.Add(-g.window)
	kept := g.calls[:0]
	for _, t := range g.calls {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	g.calls = kept
}

// usageState 是服务端的用量缓存与风控状态。
type usageState struct {
	mu sync.Mutex
	// cache 是最近一次的用量快照。
	cache *usageSnapshot
	// cacheAccount 是这份缓存对应的账号（切换账号后不能复用）。
	cacheAccount string
	// fetched 是缓存的采集时刻。
	fetched time.Time
	guard   *usageGuard
	// remote 是最近一次读到的官方速率限制头。
	remote usageRatelimit
	// ---- 每日 KV 写配额风控 ----
	// writeDay 是计数的日期（UTC），跨天自动归零。
	writeDay string
	// writeCount 是今天已用的 KV 写次数。
	writeCount int
}

// usageState 返回服务端的用量状态（首次使用时创建）。
func (s *Server) usageState() *usageState {
	s.usageOnce.Do(func() {
		s.usage = &usageState{guard: newUsageGuard(usageLocalCallLimit, usageLocalCallWindow)}
	})
	return s.usage
}

// claimDailyWrite 申请 n 次 KV 写配额（本地日风控）。
//
// 官方上限 1000 次/天（免费版），本地按十分之一封顶。
// 返回 ok=false 时调用方**必须停止写入**，并把原因告诉用户。
func (s *Server) claimDailyWrite(n int) (ok bool, used int, limit int) {
	state := s.usageState()
	today := time.Now().UTC().Format("2006-01-02")
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.writeDay != today {
		state.writeDay = today
		state.writeCount = 0
	}
	if state.writeCount+n > usageDailyWriteLimit {
		return false, state.writeCount, usageDailyWriteLimit
	}
	state.writeCount += n
	return true, state.writeCount, usageDailyWriteLimit
}

// dailyWriteUsage 返回今日已用的 KV 写次数与上限（界面显示用）。
func (s *Server) dailyWriteUsage() (used int, limit int) {
	state := s.usageState()
	today := time.Now().UTC().Format("2006-01-02")
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.writeDay != today {
		return 0, usageDailyWriteLimit
	}
	return state.writeCount, usageDailyWriteLimit
}

// handleUsage 返回账号用量与额度。
//
// GET /api/usage
func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
		return
	}
	profile, _ := s.store.Active()
	if profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "尚未保存 API Token"})
		return
	}
	accountID := strings.TrimSpace(profile.AccountID)
	if accountID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "尚未检测账号"})
		return
	}
	refresh := strings.TrimSpace(r.URL.Query().Get("refresh")) == "1"
	writeJSON(w, http.StatusOK, s.collectUsage(r.Context(), profile.CfToken, accountID, refresh))
}

// primeUsageCache 在后台采集一次用量（不阻塞调用方）。
//
// 调用点：账号识别成功、切换账户之后。
// 目的：点开「用量/额度」弹窗时直接有数据，不用临时再花一次 API 调用。
//
// ⚠️ 后台任务不阻塞接口响应；采集本身仍受本地风控与缓存 TTL 约束。
func (s *Server) primeUsageCache() {
	profile, _ := s.store.Active()
	if profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		return
	}
	accountID := strings.TrimSpace(profile.AccountID)
	if accountID == "" {
		return
	}
	state := s.usageState()
	// 缓存还新鲜就什么都不做（省一次调用）。
	state.mu.Lock()
	fresh := state.cache != nil && time.Now().UTC().Sub(state.fetched) < usageCacheTTL
	state.mu.Unlock()
	if fresh {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		generated := time.Now().UTC()
		snapshot, remote, err := s.fetchUsage(ctx, profile.CfToken, accountID, generated)
		if err != nil {
			s.logLevel("采集账号用量失败："+err.Error(), "warn")
			return
		}
		state.guard.record(generated)
		_, remaining := state.guard.allow(generated)
		snapshot.Ratelimit = remote
		snapshot.Ratelimit.LocalRemaining = remaining
		snapshot.Ratelimit.LocalLimit = state.guard.limit
		snapshot.Ratelimit.LocalWindowSec = int(usageLocalCallWindow.Seconds())
		snapshot.TTLSec = int(usageCacheTTL.Seconds())
		snapshot.GeneratedAt = generated.Format(time.RFC3339)
		snapshot.NextRefreshAt = generated.Add(usageCacheTTL).Format(time.RFC3339)
		state.mu.Lock()
		state.cache = snapshot
		state.cacheAccount = accountID
		state.fetched = generated
		state.remote = remote
		state.mu.Unlock()
	}()
}

// collectUsage 采集一次用量（带缓存与本地风控）。
//
// cacheOnly 为 true 时**只读缓存**：没有缓存就返回"尚无数据"，一次请求都不发。
func (s *Server) collectUsage(ctx context.Context, token, accountID string, cacheOnly bool) map[string]any {
	state := s.usageState()
	now := time.Now().UTC()

	state.mu.Lock()
	cached := state.cache
	cacheAccount := state.cacheAccount
	fetched := state.fetched
	state.mu.Unlock()

	// 缓存是**按账号**的：切换账号后不能拿上一个账号的数据糊弄。
	if cached != nil && cacheAccount != accountID {
		cached = nil
	}

	// 只读模式：只给缓存，绝不发起调用。
	if cacheOnly {
		if cached == nil {
			return map[string]any{"ok": false, "error": "尚未采集当前账号的用量数据，点「刷新」即可采集一次"}
		}
		out := *cached
		out.Notice = "显示的是 " + fmt.Sprintf("%d", int(now.Sub(fetched).Minutes())) +
			" 分钟前的数据（后台已自动采集，点「刷新」可更新）"
		out.NextRefreshAt = fetched.Add(usageCacheTTL).Format(time.RFC3339)
		return map[string]any{"ok": true, "usage": out}
	}

	// 缓存还有效 → 直接返回，一次 API 调用都不发。
	if cached != nil && now.Sub(fetched) < usageCacheTTL {
		out := *cached
		out.Stale = false
		out.Notice = "显示的是 " + fmt.Sprintf("%d", int(now.Sub(fetched).Minutes())) + " 分钟前的数据（缓存中）"
		out.NextRefreshAt = fetched.Add(usageCacheTTL).Format(time.RFC3339)
		return map[string]any{"ok": true, "usage": out}
	}

	// 本地风控：达到上限就不再发起调用。
	allowed, remaining := state.guard.allow(now)
	limit := state.guard.limit
	if !allowed {
		out := usageSnapshot{
			OK:            false,
			AccountID:     accountID,
			Throttled:     true,
			TTLSec:        int(usageCacheTTL.Seconds()),
			NextRefreshAt: now.Add(usageLocalCallWindow).Format(time.RFC3339),
			Ratelimit: usageRatelimit{
				LocalRemaining: 0,
				LocalLimit:     limit,
				LocalBlocked:   true,
				LocalWindowSec: int(usageLocalCallWindow.Seconds()),
			},
		}
		if cached != nil {
			out.Stale = true
			out.Limits = cached.Limits
			out.Series = cached.Series
			out.Days = cached.Days
			out.Today = cached.Today
			out.Yesterday = cached.Yesterday
			out.Average = cached.Average
			out.Storage = cached.Storage
			out.StatusCounts = cached.StatusCounts
			out.Scripts = cached.Scripts
			out.Plan = cached.Plan
			out.GeneratedAt = cached.GeneratedAt
			out.OK = true
			out.Notice = "已达本地调用上限（每 " + strconv.Itoa(int(usageLocalCallWindow.Minutes())) +
				" 分钟最多 " + strconv.Itoa(limit) + " 次），已停止刷新，显示的是旧数据"
		} else {
			out.Notice = "已达本地调用上限（每 " + strconv.Itoa(int(usageLocalCallWindow.Minutes())) +
				" 分钟最多 " + strconv.Itoa(limit) + " 次），已停止调用，稍后再试"
		}
		return map[string]any{"ok": true, "usage": out}
	}

	snapshot, remote, err := s.fetchUsage(ctx, token, accountID, now)
	state.guard.record(now)
	if err != nil {
		if cached != nil {
			stale := *cached
			stale.Stale = true
			stale.OK = true
			stale.Notice = "刷新失败：" + err.Error() + "（显示旧数据）"
			stale.Ratelimit = remote
			stale.Ratelimit.LocalRemaining = remaining
			stale.Ratelimit.LocalLimit = limit
			stale.Ratelimit.LocalWindowSec = int(usageLocalCallWindow.Seconds())
			return map[string]any{"ok": true, "usage": stale}
		}
		return map[string]any{"ok": false, "error": err.Error()}
	}

	snapshot.Ratelimit = remote
	snapshot.Ratelimit.LocalRemaining = remaining
	snapshot.Ratelimit.LocalLimit = limit
	snapshot.Ratelimit.LocalWindowSec = int(usageLocalCallWindow.Seconds())
	snapshot.TTLSec = int(usageCacheTTL.Seconds())
	snapshot.NextRefreshAt = now.Add(usageCacheTTL).Format(time.RFC3339)
	snapshot.GeneratedAt = now.Format(time.RFC3339)
	snapshot.DailyWriteUsed, snapshot.DailyWriteLimit = s.dailyWriteUsage()

	state.mu.Lock()
	state.cache = snapshot
	state.cacheAccount = accountID
	state.fetched = now
	state.remote = remote
	state.mu.Unlock()

	return map[string]any{"ok": true, "usage": snapshot}
}

// collectInstances 列出账号里的部署实例，并标出哪些是本工具部署的。
//
// ## 为什么要做
//
// Workers 分析数据集**只含 Worker，不含 Pages**。
// CFPilot 默认部署成 Pages 项目（控制面 + 数据面），
// 它的调用不在这份统计里 ——
// 不标出来的话，界面上的请求数会被误读成"CFPilot 的消耗"。
//
// 识别依据：本机留档的部署清单（控制面 / 数据面项目名），
// 外加「CFPilot / cfpilot / cpmanager」这类明显的命名。
func (s *Server) collectInstances(ctx context.Context, token, accountID string, snapshot *usageSnapshot) ([]usageInstance, int64, string) {
	// 本工具部署过的项目名（来自本地部署留档）。
	known := map[string]bool{}
	if snap := s.loadSnapshot(); snap != nil && snap.AccountID == accountID {
		if snap.ControlProject != "" {
			known[snap.ControlProject] = true
		}
		if snap.DataProject != "" {
			known[snap.DataProject] = true
		}
	}
	// 部署清单是最准的依据：它记着控制面 / 数据面的项目名。
	// 本机没有留档（换机器操作）时，从**当前选中的 KV**里读清单。
	names := s.cfpilotProjectNames(ctx, token, accountID)
	for _, name := range names {
		known[name] = true
	}
	instances := []usageInstance{}

	// ---- Pages 项目 ----
	var pages struct {
		Result []struct {
			Name string `json:"name"`
		} `json:"result"`
	}
	if _, err := s.cfJSON(ctx, token, http.MethodGet, "/accounts/"+accountID+"/pages/projects", nil, &pages); err == nil {
		for _, item := range pages.Result {
			instances = append(instances, usageInstance{
				Name:    item.Name,
				Kind:    "pages",
				CFPilot: known[item.Name] || looksLikeCFPilot(item.Name),
			})
		}
	}

	// ---- Worker 脚本 ----
	var workers struct {
		Result []struct {
			ID string `json:"id"`
		} `json:"result"`
	}
	if _, err := s.cfJSON(ctx, token, http.MethodGet, "/accounts/"+accountID+"/workers/scripts", nil, &workers); err == nil {
		for _, item := range workers.Result {
			instances = append(instances, usageInstance{
				Name:    item.ID,
				Kind:    "worker",
				CFPilot: known[item.ID] || looksLikeCFPilot(item.ID),
			})
		}
	}

	// 属于本工具 Worker 的请求数（Pages 形态则恒为 0）。
	var cfpilotRequests int64
	for _, item := range snapshot.Scripts {
		if item.CFPilot {
			cfpilotRequests += item.Requests
		}
	}
	// 统计里出现过的脚本（请求数 > 0）才算"有消耗"。
	seen := map[string]bool{}
	for _, item := range snapshot.Scripts {
		if item.Requests > 0 {
			seen[item.Name] = true
		}
	}
	hasCFPilotPages := false
	hasCFPilotWorker := false
	for _, inst := range instances {
		if !inst.CFPilot {
			continue
		}
		if inst.Kind == "pages" {
			hasCFPilotPages = true
		} else if seen[inst.Name] {
			hasCFPilotWorker = true
		}
	}
	note := "以上为账号下所有 Worker 的合计（含与本工具无关的 Worker）"
	switch {
	case hasCFPilotPages && !hasCFPilotWorker:
		note = "本工具的实例是 Pages 形态，其调用不计入 Workers 统计；以上为账号下其他 Worker 的合计"
	case hasCFPilotWorker:
		note = "已标出属于本工具的 Worker；其余为账号下其他 Worker"
	}
	return instances, cfpilotRequests, note
}

// looksLikeCFPilot 判断一个项目 / 脚本名是否明显是本工具部署的。
func looksLikeCFPilot(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "cfpilot") || strings.Contains(lower, "cpmanager")
}

// cfpilotProjectNames 找出本工具部署的 Pages 项目名。
//
// 依据是**部署清单**（CFP_DEPLOY_MANIFEST），它记着控制面与数据面的项目名 ——
// 这是唯一可靠的依据（标题、UUID 等字段值都不唯一）。
//
// 读的是**当前选中的 KV**（一次请求），而不是遍历所有命名空间：
// 账号里可能有很多命名空间，逐个读既慢又费 API 配额。
func (s *Server) cfpilotProjectNames(ctx context.Context, token, accountID string) []string {
	profile, _ := s.store.Active()
	if profile == nil {
		return nil
	}
	nsID := strings.TrimSpace(profile.KVNamespaceID)
	if nsID == "" {
		return nil
	}
	raw, err := s.cfRaw(ctx, token, "/accounts/"+accountID+"/storage/kv/namespaces/"+nsID+"/values/CFP_DEPLOY_MANIFEST")
	if err != nil || raw == "" {
		return nil
	}
	var manifest struct {
		ControlProject string `json:"controlProject"`
		DataProject    string `json:"dataProject"`
	}
	if err := json.Unmarshal([]byte(raw), &manifest); err != nil {
		return nil
	}
	out := []string{}
	if manifest.ControlProject != "" {
		out = append(out, manifest.ControlProject)
	}
	if manifest.DataProject != "" && manifest.DataProject != manifest.ControlProject {
		out = append(out, manifest.DataProject)
	}
	return out
}

// cfRaw 读一个 KV 值（原始文本）。
func (s *Server) cfRaw(ctx context.Context, token, path string) (string, error) {
	base := s.cfBase
	if base == "" {
		base = cfapi.DefaultAPIBase
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// usageGraphQLResponse 是分析接口的响应。
type usageGraphQLResponse struct {
	Data struct {
		Viewer struct {
			Accounts []struct {
				Workers []struct {
					Sum struct {
						Requests    int64 `json:"requests"`
						Errors      int64 `json:"errors"`
						Subrequests int64 `json:"subrequests"`
					} `json:"sum"`
					Dimensions struct {
						Date       string `json:"date"`
						ScriptName string `json:"scriptName"`
						Status     string `json:"status"`
					} `json:"dimensions"`
				} `json:"workersInvocationsAdaptive"`
				KVOperations []struct {
					Sum struct {
						Requests int64 `json:"requests"`
					} `json:"sum"`
					Dimensions struct {
						Date       string `json:"date"`
						ActionType string `json:"actionType"`
					} `json:"dimensions"`
				} `json:"kvOperationsAdaptiveGroups"`
				KVStorage []struct {
					Max struct {
						KeyCount  int64 `json:"keyCount"`
						ByteCount int64 `json:"byteCount"`
					} `json:"max"`
					Dimensions struct {
						Date string `json:"date"`
					} `json:"dimensions"`
				} `json:"kvStorageAdaptiveGroups"`
			} `json:"accounts"`
		} `json:"viewer"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// fetchUsage 真正发起 Cloudflare 请求，取回用量数据。
//
// 只用两个请求：一次 GraphQL（三个数据集）+ 一次 REST（套餐）。
func (s *Server) fetchUsage(ctx context.Context, token, accountID string, now time.Time) (*usageSnapshot, usageRatelimit, error) {
	remote := usageRatelimit{}
	// GraphQL：workers 按天 × 脚本 × 状态、KV 按天 × 操作类型、KV 存储。
	since := now.AddDate(0, 0, -7).Format("2006-01-02T15:04:05Z")
	day := now.AddDate(0, 0, -7).Format("2006-01-02")
	query := fmt.Sprintf(`query {
  viewer {
    accounts(filter: {accountTag: "%s"}) {
      workersInvocationsAdaptive(limit: 500, orderBy: [date_DESC], filter: {datetime_geq: "%s"}) {
        sum { requests errors subrequests }
        dimensions { date scriptName status }
      }
      kvOperationsAdaptiveGroups(limit: 500, orderBy: [date_DESC], filter: {date_geq: "%s"}) {
        sum { requests }
        dimensions { date actionType }
      }
      kvStorageAdaptiveGroups(limit: 5, orderBy: [date_DESC], filter: {date_geq: "%s"}) {
        max { keyCount byteCount }
        dimensions { date }
      }
    }
  }
}`, accountID, since, day, day)

	var gql usageGraphQLResponse
	headers, err := s.cfJSON(ctx, token, http.MethodPost, usageGraphQLPath, map[string]any{"query": query}, &gql)
	remote = parseRatelimit(headers, remote)
	if err != nil {
		return nil, remote, err
	}
	if len(gql.Errors) > 0 {
		messages := make([]string, 0, len(gql.Errors))
		for _, item := range gql.Errors {
			messages = append(messages, item.Message)
		}
		joined := strings.Join(messages, "；")
		if strings.Contains(joined, "not authorized") || strings.Contains(joined, "permission") ||
			strings.Contains(joined, "Authentication error") || strings.Contains(joined, "Unknown field") {
			return nil, remote, fmt.Errorf("分析接口无权访问或字段不受支持：%s（令牌需要 Account → Account Analytics → Read 权限）", joined)
		}
		return nil, remote, fmt.Errorf("分析接口返回错误：%s", joined)
	}
	accounts := gql.Data.Viewer.Accounts
	if len(accounts) == 0 {
		return nil, remote, fmt.Errorf("分析接口没有返回该账号的数据")
	}
	account := accounts[0]

	snapshot := &usageSnapshot{
		OK:             true,
		AccountID:      accountID,
		Limits:         freeUsageLimits(),
		StatusCounts:   map[string]int64{},
		StatusByScript: map[string]map[string]int64{},
	}

	// ---- 逐日汇总（近 7 天，今天在最后） ----
	days := make([]string, 0, 7)
	for i := 6; i >= 0; i-- {
		days = append(days, now.AddDate(0, 0, -i).Format("2006-01-02"))
	}
	indexOf := map[string]int{}
	for i, d := range days {
		indexOf[d] = i
	}
	points := make([]usagePoint, len(days))
	for _, row := range account.Workers {
		idx, ok := indexOf[strings.TrimSpace(row.Dimensions.Date)]
		if !ok {
			continue
		}
		points[idx].WorkersRequests += row.Sum.Requests
		points[idx].WorkersErrors += row.Sum.Errors
		points[idx].WorkersSubreq += row.Sum.Subrequests
		snapshot.StatusCounts[row.Dimensions.Status] += row.Sum.Requests
		// 每个脚本 × 每种状态的次数（悬浮提示要按脚本拆开看）
		scriptName := row.Dimensions.ScriptName
		if scriptName == "" {
			scriptName = "(未命名)"
		}
		byStatus, ok := snapshot.StatusByScript[scriptName]
		if !ok {
			byStatus = map[string]int64{}
			snapshot.StatusByScript[scriptName] = byStatus
		}
		byStatus[row.Dimensions.Status] += row.Sum.Requests
	}
	for _, row := range account.KVOperations {
		idx, ok := indexOf[strings.TrimSpace(row.Dimensions.Date)]
		if !ok {
			continue
		}
		switch row.Dimensions.ActionType {
		case "read":
			points[idx].KVReads += row.Sum.Requests
		case "write":
			points[idx].KVWrites += row.Sum.Requests
		case "delete":
			points[idx].KVDeletes += row.Sum.Requests
		}
	}
	snapshot.Days = days
	snapshot.Series = points
	if len(points) > 0 {
		snapshot.Today = points[len(points)-1]
		snapshot.Yesterday = points[len(points)-2]
		var sum usagePoint
		for _, p := range points {
			sum.WorkersRequests += p.WorkersRequests
			sum.KVReads += p.KVReads
			sum.KVWrites += p.KVWrites
			sum.WorkersErrors += p.WorkersErrors
		}
		n := int64(len(points))
		snapshot.Average = usagePoint{
			WorkersRequests: sum.WorkersRequests / n,
			KVReads:         sum.KVReads / n,
			KVWrites:        sum.KVWrites / n,
			WorkersErrors:   sum.WorkersErrors / n,
		}
	}
	for _, row := range account.KVStorage {
		if row.Max.ByteCount > snapshot.Storage.Bytes {
			snapshot.Storage.Bytes = row.Max.ByteCount
			snapshot.Storage.KeyCount = row.Max.KeyCount
		}
	}

	// ---- 按脚本汇总（Top 8） ----
	byScript := map[string]*usageScript{}
	for _, row := range account.Workers {
		name := row.Dimensions.ScriptName
		if name == "" {
			name = "(未命名)"
		}
		item, ok := byScript[name]
		if !ok {
			item = &usageScript{Name: name}
			byScript[name] = item
		}
		item.Requests += row.Sum.Requests
		item.Errors += row.Sum.Errors
	}
	scripts := make([]usageScript, 0, len(byScript))
	for _, item := range byScript {
		scripts = append(scripts, *item)
	}
	sort.Slice(scripts, func(i, j int) bool { return scripts[i].Requests > scripts[j].Requests })
	if len(scripts) > 8 {
		scripts = scripts[:8]
	}
	snapshot.Scripts = scripts

	// ---- 账号里的实例（Pages / Worker），标出哪些是本工具的 ----
	instances, cfpilotRequests, scopeNote := s.collectInstances(ctx, token, accountID, snapshot)
	snapshot.Instances = instances
	snapshot.CFPilotWorkerRequests = cfpilotRequests
	snapshot.ScopeNote = scopeNote
	for i := range snapshot.Scripts {
		for _, inst := range instances {
			if inst.Kind == "worker" && inst.CFPilot && inst.Name == snapshot.Scripts[i].Name {
				snapshot.Scripts[i].CFPilot = true
			}
		}
	}

	// ---- 套餐（拿不到就按 Free 估算，并标注） ----
	limits := freeUsageLimits()
	planName := ""
	var subs struct {
		Result []struct {
			RatePlan struct {
				ID         string `json:"id"`
				PublicName string `json:"public_name"`
				Scope      string `json:"scope"`
			} `json:"rate_plan"`
		} `json:"result"`
	}
	planNote := ""
	if _, err := s.cfJSON(ctx, token, http.MethodGet, "/accounts/"+accountID+"/subscriptions", nil, &subs); err != nil {
		planNote = "（未取得订阅信息，暂按 Free 套餐上限估算）"
	} else if len(subs.Result) > 0 {
		// ⚠️ 一个账号的订阅列表里可能有**多条**计划
		// （SSL For SAAS Basic / Cloudflare Free Plan / Teams Free Base …），
		// 决定 Workers / KV 免费额度的是**站点那条**（scope = zone），
		// 直接取第一条会把它当成付费套餐 → 误显示「无限制」。
		chosen := subs.Result[0]
		for _, item := range subs.Result {
			if strings.EqualFold(item.RatePlan.Scope, "zone") {
				chosen = item
				break
			}
		}
		id := strings.ToLower(strings.TrimSpace(chosen.RatePlan.ID))
		planName = chosen.RatePlan.PublicName
		if id != "free" {
			limits = paidUsageLimits()
			limits.Plan = id
		}
	}
	snapshot.Limits = limits
	snapshot.Limits.PlanName = planName
	if planNote != "" {
		snapshot.Notice = planNote
	}
	return snapshot, remote, nil
}

// cfJSON 发一个 Cloudflare API 请求（GET 或 POST JSON），并返回响应头。
func (s *Server) cfJSON(ctx context.Context, token, method, path string, payload any, out any) (http.Header, error) {
	base := s.cfBase
	if base == "" {
		base = cfapi.DefaultAPIBase
	}
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 40 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 Cloudflare API 失败：%w", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return res.Header, fmt.Errorf("读取响应失败：%w", err)
	}
	if res.StatusCode >= 400 {
		return res.Header, fmt.Errorf("Cloudflare API 返回 HTTP %d：%s", res.StatusCode, strings.TrimSpace(truncateForMessage(string(raw))))
	}
	if out == nil {
		return res.Header, nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return res.Header, fmt.Errorf("解析响应失败：%w", err)
	}
	return res.Header, nil
}

// parseRatelimit 解析响应头里的速率限制信息。
//
// Cloudflare 返回：
//
//	Ratelimit: "default";r=1199;t=1
//	Ratelimit-Policy: "default";q=1200;w=300
//
// r = 剩余次数，q = 窗口配额，w = 窗口秒数。
func parseRatelimit(headers http.Header, out usageRatelimit) usageRatelimit {
	if headers == nil {
		return out
	}
	value := headers.Get("Ratelimit")
	if value != "" {
		out.RemoteRemaining = parseRatelimitField(value, "r")
	}
	policy := headers.Get("Ratelimit-Policy")
	if policy != "" {
		out.RemoteLimit = parseRatelimitField(policy, "q")
		out.RemoteWindowSec = parseRatelimitField(policy, "w")
	}
	return out
}

// parseRatelimitField 从 `default";r=1199;t=1` 里取某个字段。
func parseRatelimitField(value, key string) int {
	for _, part := range strings.Split(value, ";") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, key+"=") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(part, key+"=")))
		if err != nil {
			return 0
		}
		return n
	}
	return 0
}

// truncateForMessage 截断过长的错误消息。
func truncateForMessage(text string) string {
	text = strings.ReplaceAll(strings.TrimSpace(text), "\n", " ")
	if len(text) > 300 {
		return text[:300] + "…"
	}
	return text
}
