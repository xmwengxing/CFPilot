package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// 一键优选（优选 + 回填）：
//
//	POST /api/scan/quick
//
// 托盘菜单的「一键优选 IP」子菜单与界面上的同名按钮都调它。
//
// 流程（全程自动，用户只需要等）：
//  1. 从 KV 清单读出数据面域名 + WS 路径 + 控制面域名 + 面板密码
//  2. 采样候选 IP
//  3. 三阶扫描（TCP → TLS → WS 101 + PING）
//  4. 取临时令牌并回填面板
//  5. 返回摘要（成功条数 / 域名），由调用方弹气泡通知
//
// ⚠️ 与「本地真连接优选」页的区别：这里不采集候选、不跳测速、
// 用默认参数，追求的是「点一下就有结果」。
//
// ## 托盘为什么要能指定账号
//
// 用户可能有好几个 Cloudflare 账号，而托盘菜单里点的是**某一个账号**。
// 所以真正的实现是 RunQuickScanFor：它用传进来的 profile 读
// **那个账号自己的** Token / KV 清单 / 面板密码，回填也回到那个账号的面板。
// RunQuickScan 只是「当前活跃账号 + 无进度回调」的兼容包装 ——
// HTTP 端点行为与改造前保持一致（仍然按活跃账号跑）。
func (s *Server) handleScanQuick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	// ⚠️ 用 Background 而不是 r.Context()。
	//
	// 一键优选是后台任务（1~3 分钟），用户点完按钮很可能就关掉界面标签页。
	// 绑在请求上下文上会让扫描被**无声取消**，用户回来只看到「没有结果」。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	res := s.RunQuickScan(ctx)
	writeJSON(w, http.StatusOK, res)
}

// QuickScanResult 是一键优选的结果（也用作 HTTP 响应体）。
type QuickScanResult struct {
	OK      bool   `json:"ok"`
	Count   int    `json:"count,omitempty"`
	Host    string `json:"host,omitempty"`
	Panel   string `json:"panel,omitempty"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

// QuickScanAccount 是托盘「一键优选 IP」子菜单需要的账号摘要。
//
// 只含展示必需的字段 —— **绝不带 Token / 面板密码**：
// 托盘只是 UI 层，不需要也不应该持有凭据。
type QuickScanAccount struct {
	// ID 是凭据库里的稳定标识（acc_xxxxxxxx），点菜单时用它回传
	ID string
	// Name 是账号展示名（凭据库推导：账号名，或「账户 <ID前8位>」）
	Name string
	// AccountID 是 Cloudflare 账号 ID（非敏感），菜单标题里取前 8 位
	AccountID string
	// Active 表示这是当前活跃账号（菜单项上打勾）
	Active bool
}

// QuickScanAccounts 返回本机已保存的账号摘要（按凭据库顺序），供托盘构建子菜单。
//
// 读凭据失败时返回空列表：托盘最多显示「暂无账号」，不会崩。
func (s *Server) QuickScanAccounts() []QuickScanAccount {
	profiles, err := s.store.List()
	if err != nil {
		return nil
	}
	activeID, _ := s.store.ActiveID()
	out := make([]QuickScanAccount, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, QuickScanAccount{
			ID:        p.ID,
			Name:      p.Name,
			AccountID: p.AccountID,
			Active:    p.ID == activeID,
		})
	}
	return out
}

// QuickScanProfile 按 ID 取账号（id 为空 = 当前活跃账号）。
//
// 托盘只持有菜单项对应的账号 ID，不直接接触凭据库，所以需要这个入口。
// 找不到时返回 (nil, nil) —— **调用方必须把 nil 当成「账号不存在」处理，
// 不能退回活跃账号**：否则点 A 账号的菜单项却用 B 账号跑，
// 优选结果会被回填到另一个账号的面板（串号）。
func (s *Server) QuickScanProfile(id string) (*store.Profile, error) {
	if strings.TrimSpace(id) == "" {
		return s.store.Active()
	}
	return s.store.Get(strings.TrimSpace(id))
}

// RunQuickScan 用**当前活跃账号**跑一次一键优选（兼容入口，无进度回调）。
//
// HTTP 端点 /api/scan/quick 用的就是它 —— 行为与改造前完全一致。
func (s *Server) RunQuickScan(ctx context.Context) QuickScanResult {
	return s.RunQuickScanFor(ctx, nil, nil)
}

// RunQuickScanFor 用指定账号跑一次一键优选，并逐条回调进度。
//
// profile 为 nil 时回落到当前活跃账号（HTTP 端点的行为）；
// onProgress 可为 nil（不需要进度）。
//
// ## 并发保护
//
// 扫描互斥（s.scan.mu / s.scan.running，与 /api/scan/run 共用）在这里抢，
// **不放在 HTTP handler 里**：托盘菜单是直接调这个方法的，如果互斥写在上层，
// 托盘与界面按钮同时点就会有两个扫描真的在跑（采样 + 1500 并发探测，
// 互相抢带宽还会把结果搞乱）。
//
// ## 进度语义
//
// onProgress 收到的是**逐候选**的原始事件（阶段 prepare / tcp / tls / probe），
// 外加本函数补的「回填」阶段（stage=push）。
// 调用方（托盘）自己负责节流：菜单标题最多每几百毫秒刷一次，
// 日志走另一条路（scan.ProgressThrottle），两者互不影响。
func (s *Server) RunQuickScanFor(ctx context.Context, profile *store.Profile, onProgress func(scan.Progress)) QuickScanResult {
	// ---- 0. 抢扫描互斥（同一时刻只允许一个扫描）----
	s.scan.mu.Lock()
	if s.scan.running {
		s.scan.mu.Unlock()
		return QuickScanResult{OK: false, Error: "已有扫描正在进行，请等它结束"}
	}
	scanCtx, cancelScan := context.WithCancel(ctx)
	s.scan.running = true
	s.scan.cancel = cancelScan
	s.scan.mu.Unlock()
	defer func() {
		s.scan.mu.Lock()
		s.scan.running = false
		s.scan.cancel = nil
		s.scan.mu.Unlock()
		cancelScan()
	}()

	// ---- 1. 确定账号并按**它自己**的凭据做校验 ----
	if profile == nil {
		p, err := s.store.Active()
		if err != nil || p == nil {
			return QuickScanResult{OK: false, Error: "尚未保存 API Token，请先在「凭据」页添加"}
		}
		profile = p
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		return QuickScanResult{OK: false, Error: "尚未保存 API Token，请先在「凭据」页添加"}
	}
	if strings.TrimSpace(profile.AccountID) == "" || strings.TrimSpace(profile.KVNamespaceID) == "" {
		return QuickScanResult{OK: false, Error: "还没有检测账号或选择 KV，请先在「凭据」页完成"}
	}

	acctLabel := strings.TrimSpace(profile.Name)
	if acctLabel == "" {
		acctLabel = "当前账号"
	}
	reportQuickScanProgress(onProgress, scan.Progress{Stage: "prepare", Message: "正在读取部署清单"})

	// ---- 2. 读清单：数据面域名 / WS 路径 / 控制面 / 面板密码 ----
	client := s.newCFClient(profile.CfToken)
	readCtx, cancelRead := context.WithTimeout(ctx, 20*time.Second)
	raw, ok := client.GetKVValue(readCtx, profile.AccountID, profile.KVNamespaceID, deploy.ManifestKey)
	cancelRead()
	if !ok || strings.TrimSpace(raw) == "" {
		return QuickScanResult{OK: false, Error: "没有找到部署清单，请先完成一次部署"}
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return QuickScanResult{OK: false, Error: "部署清单格式损坏"}
	}

	host := m.DataCustomDomain
	if host == "" {
		host = normalizePagesHost(m.DataSubdomain)
	}
	if host == "" {
		return QuickScanResult{OK: false, Error: "清单里没有可用的数据面域名"}
	}

	wsPath := strings.TrimSpace(m.Credentials.WSPath)
	if wsPath == "" {
		wsPath = scan.ProbeDefaultPath
	}

	_, panelHost, panelPassword := s.resolvePanelAccess(ctx, profile)
	if panelHost == "" {
		return QuickScanResult{OK: false, Error: "清单里没有控制面域名，请先完成一次部署"}
	}
	if panelPassword == "" && m.Credentials.PanelPassword != "" {
		panelPassword = strings.TrimSpace(m.Credentials.PanelPassword)
	}
	if panelPassword == "" {
		return QuickScanResult{OK: false, Error: "找不到面板密码，请先在部署页填写并保存"}
	}

	s.logf(fmt.Sprintf("一键优选开始（账号：%s）：数据面 %s，控制面 %s", acctLabel, host, panelHost))

	// ---- 3. 采样候选 ----
	//
	// 采样 1500 而不是更多：一键优选是**后台任务**，
	// 用户等的是结果不是覆盖率；而且网络被限速时
	// 大样本会显著拉长耗时（自适应并发会退到低并发跑完整批次）。
	candidates := scan.SampleCandidates(scan.SampleOptions{Count: 1500})
	if len(candidates) == 0 {
		return QuickScanResult{OK: false, Error: "未能生成候选 IP"}
	}
	s.logf(fmt.Sprintf("已生成 %d 个候选 IP", len(candidates)))

	// ---- 4. 扫描 ----
	scanCtx, cancelScanRun := context.WithTimeout(scanCtx, 12*time.Minute)
	defer cancelScanRun()

	// 进度节流器（见 scan.ProgressThrottle）—— 只用于**日志**。
	// 托盘菜单的实时标题由 onProgress 自己节流，两条路互不影响。
	throttle := scan.NewProgressThrottle()

	summary, err := scan.Run(scanCtx, scan.Options{
		Host:       host,
		Port:       443,
		WSPath:     wsPath,
		ProbePath:  scan.ProbeDefaultPath,
		Candidates: candidates,
		SkipSpeed:  true, // 一键优选不测速：要的是「可用」，不是「快」
		Top:        8,    // 与 CLI / 界面的默认 top 一致（2026-10-28 起 15 → 8）
		// 一键优选要跑一分多钟，没有进度用户会以为卡住了。
		// 逐候选事件先喂给进度回调（托盘实时标题），日志再走节流。
		Progress: func(p scan.Progress) {
			// 一键优选固定 SkipSpeed，但扫描器仍会报一条
			// 「阶段三：跳过测速」的 speed 事件（Done=0）。
			// 对托盘来说它不是真进度 —— 转过去会闪一下「测速 0/N · 0%」，
			// 所以只在日志里保留，不喂给进度回调。
			if p.Stage != "speed" {
				reportQuickScanProgress(onProgress, p)
			}
			if !throttle.ShouldReport(p) {
				return
			}
			msg := p.Message
			if p.Total > 0 {
				msg = fmt.Sprintf("%s（%d/%d）", p.Message, p.Done, p.Total)
			}
			s.logf(msg)
		},
	})
	if err != nil {
		return QuickScanResult{OK: false, Error: "扫描失败：" + err.Error()}
	}
	if len(summary.Entries) == 0 {
		return QuickScanResult{OK: false, Error: "没有找到可用的 IP（可稍后重试，或先检查实例是否正常）"}
	}
	s.logf(fmt.Sprintf("扫描完成，%d 个可用节点", len(summary.Entries)))

	// ---- 4.5 写入优选历史（与本地真连接优选共用同一份留底）----
	s.saveScanHistory("quick", host, wsPath, scan.ProbeDefaultPath, true, summary.Entries)

	// ---- 5. 回填面板 ----
	//
	// 回填也要进度：取令牌 + 写面板虽然只要几秒，但托盘菜单标题
	// 卡在「WS 校验 120/120 · 100%」会让人以为程序停了。
	reportQuickScanProgress(onProgress, scan.Progress{Stage: "push", Message: "正在回填面板"})

	tok := scan.FetchScannerToken(scanCtx, panelHost, panelPassword, 25*time.Second)
	if !tok.OK {
		return QuickScanResult{OK: false, Error: "获取面板令牌失败：" + tok.Error}
	}

	lines := make([]string, 0, len(summary.Entries))
	for _, e := range summary.Entries {
		lines = append(lines, fmt.Sprintf("%s:%d#%s", e.IP, e.Port, e.Colo))
	}
	pushRes := scan.PostResults(scanCtx, scan.DefaultCallbackURL(panelHost), tok.Token, lines, 20*time.Second)
	if !pushRes.OK {
		return QuickScanResult{OK: false, Error: "回填失败：" + pushRes.Error}
	}
	reportQuickScanProgress(onProgress, scan.Progress{Stage: "push", Done: 1, Total: 1, Message: "回填完成"})

	msg := fmt.Sprintf("优选 IP 成功，共有 %d 个优选 IP 已填入面板", len(lines))
	s.logLevel(msg, "ok")

	return QuickScanResult{
		OK:      true,
		Count:   len(lines),
		Host:    host,
		Panel:   panelHost,
		Message: msg,
	}
}

// reportQuickScanProgress 把进度事件转给调用方（nil 安全）。
//
// 单独抽出来是为了让「要不要进度」只判断一次，
// 避免每处回调都写 `if onProgress != nil`。
func reportQuickScanProgress(onProgress func(scan.Progress), p scan.Progress) {
	if onProgress != nil {
		onProgress(p)
	}
}
