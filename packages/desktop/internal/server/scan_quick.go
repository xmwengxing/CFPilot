package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// 一键优选（优选 + 回填）：
//
//	POST /api/scan/quick
//
// 托盘菜单的「一键优选 IP」与界面上的同名按钮都调它。
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
func (s *Server) handleScanQuick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	// 同一时刻只允许一个扫描（与 /api/scan/run 同一个互斥）
	s.scan.mu.Lock()
	if s.scan.running {
		s.scan.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "已有扫描正在进行，请等它结束",
		})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.scan.running = true
	s.scan.cancel = cancel
	s.scan.mu.Unlock()

	defer func() {
		s.scan.mu.Lock()
		s.scan.running = false
		s.scan.cancel = nil
		s.scan.mu.Unlock()
	}()

	res := s.RunQuickScan(ctx)
	writeJSON(w, http.StatusOK, res)
}

// quickScanResult 是一键优选的结果（也用作 HTTP 响应体）。
type QuickScanResult struct {
	OK      bool   `json:"ok"`
	Count   int    `json:"count,omitempty"`
	Host    string `json:"host,omitempty"`
	Panel   string `json:"panel,omitempty"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

// runQuickScan 执行一键优选 + 回填。
//
// 单独抽出来是为了让 HTTP 端点与托盘菜单共用同一套逻辑
// （托盘直接调这个方法，不必绕一圈 HTTP）。
func (s *Server) RunQuickScan(ctx context.Context) QuickScanResult {
	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		return QuickScanResult{OK: false, Error: "尚未保存 API Token，请先在「凭据」页添加"}
	}
	if strings.TrimSpace(profile.AccountID) == "" || strings.TrimSpace(profile.KVNamespaceID) == "" {
		return QuickScanResult{OK: false, Error: "还没有检测账号或选择 KV，请先在「凭据」页完成"}
	}

	// ---- 1. 读清单：数据面域名 / WS 路径 / 控制面 / 面板密码 ----
	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
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

	s.logf(fmt.Sprintf("一键优选开始：数据面 %s，控制面 %s", host, panelHost))

	// ---- 2. 采样候选 ----
	//
	// 采样 1500 而不是更多：一键优选是**后台任务**，
	// 用户等的是结果不是覆盖率；而且网络被限速时
	// 大样本会显著拉长耗时（自适应并发会退到低并发跑完整批次）。
	candidates := scan.SampleCandidates(scan.SampleOptions{Count: 1500})
	if len(candidates) == 0 {
		return QuickScanResult{OK: false, Error: "未能生成候选 IP"}
	}
	s.logf(fmt.Sprintf("已生成 %d 个候选 IP", len(candidates)))

	// ---- 3. 扫描 ----
	scanCtx, cancelScan := context.WithTimeout(ctx, 12*time.Minute)
	defer cancelScan()

	// 进度节流器（见 scan.ProgressThrottle）
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
		// 同样要节流 —— 逐候选报会把日志冲垮。
		Progress: func(p scan.Progress) {
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

	// ---- 4. 回填面板 ----
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
