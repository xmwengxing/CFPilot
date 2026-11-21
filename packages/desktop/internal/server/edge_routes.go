package server

// 本文件实现「盲中继 / 云监测台」部署 API。
//
//	POST /api/edge/deploy   → 立即返回 {started:true}，进度走 SSE log，完成推 edge-result
//	GET  /api/edge/zones    → 列出账号下的 zone（供域名下拉）
//
// 与 CLI `cfpilot edge deploy` 同源（packages/cli/src/edge/deploy.ts），
// 实际编排在 internal/edge.Deploy。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/edge"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/safe"
)

// edgeState 是盲中继部署的进程内互斥（与代理部署 deployState 独立）。
type edgeState struct {
	mu      sync.Mutex
	running bool
}

func (s *Server) registerEdgeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/edge/deploy", s.guard(s.handleEdgeDeploy))
	mux.HandleFunc("/api/edge/check", s.guard(s.handleEdgeCheck))
	mux.HandleFunc("/api/edge/zones", s.guard(s.handleEdgeZones))
}

type edgeDeployRequest struct {
	Domain           string `json:"domain"`
	WorkerName       string `json:"workerName"`
	MonitorPassword  string `json:"monitorPassword"`
	MonitorToken     string `json:"monitorToken"`
	DashboardProject string `json:"dashboardProject"`
	WithDashboard    *bool  `json:"withDashboard"`
	ZoneID           string `json:"zoneId"`
	AutoDNS          bool   `json:"autoDns"`
	WindowMs         string `json:"windowMs"`
	MaxBytes         string `json:"maxBytes"`
	MaxPackets       string `json:"maxPackets"`
	MaxPeers         string `json:"maxPeers"`
}

// edgeActiveToken 从当前 profile 取 token + account（与 deploy 一致）。
// activeTokenOnly 只要求 Token（列 Zone 不需要账号 ID）。
// 旧实现走 edgeActiveToken 强制要求 accountID，账户里没存就会「加载失败」，
// 用户看到的是「未选择 Cloudflare Zone」，完全误导。
func (s *Server) activeTokenOnly() (string, error) {
	profile, err := s.store.Active()
	if err != nil || profile == nil {
		return "", fmt.Errorf("尚未保存 Cloudflare 凭据，请先在「账户配置」填写 API Token")
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		return "", fmt.Errorf("缺少 API Token，请先在「账户配置」里填写")
	}
	return profile.CfToken, nil
}

func (s *Server) edgeActiveToken() (token, accountID string, err error) {
	profile, err := s.store.Active()
	if err != nil || profile == nil {
		return "", "", fmt.Errorf("尚未保存 Cloudflare 凭据")
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		return "", "", fmt.Errorf("缺少 API Token，请先在「账户配置」里填写")
	}
	if strings.TrimSpace(profile.AccountID) == "" {
		return "", "", fmt.Errorf("缺少账号 ID，请先点「自动检测账号」")
	}
	return profile.CfToken, profile.AccountID, nil
}

// matchZoneID 按最长后缀匹配域名所属 zone（relay.a.example.com → example.com）。
func matchZoneID(zones []cfapi.Zone, domain string) string {
	domain = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	best := ""
	bestLen := 0
	for _, z := range zones {
		name := strings.ToLower(strings.TrimSuffix(z.Name, "."))
		if name == "" {
			continue
		}
		if domain == name || strings.HasSuffix(domain, "."+name) {
			if len(name) > bestLen {
				best = z.ID
				bestLen = len(name)
			}
		}
	}
	return best
}

// resolveEdgeAccountID 解析本次要用的账号 ID。
//
// 优先用已保存的；没存就用 Token 自动探测（不让用户卡在「请先自动检测账号」）。
// 部署与检测共用同一策略，避免两处行为不一致。
func (s *Server) resolveEdgeAccountID(ctx context.Context, token string) (string, error) {
	if profile, err := s.store.Active(); err == nil && profile != nil {
		if id := strings.TrimSpace(profile.AccountID); id != "" {
			return id, nil
		}
	}
	accounts, err := s.newCFClient(token).ListAccounts(ctx)
	if err != nil {
		return "", fmt.Errorf("无法确定 Cloudflare 账号 ID（Token 读不到账号列表）：%w", err)
	}
	if len(accounts) == 0 {
		return "", fmt.Errorf("无法确定 Cloudflare 账号 ID（Token 下没有可用账号），请先在「账户配置」点「检测账号」")
	}
	return accounts[0].ID, nil
}

func (s *Server) handleEdgeDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req edgeDeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	if strings.TrimSpace(req.Domain) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请填写盲中继域名"})
		return
	}
	token, err := s.activeTokenOnly()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	accountID, err := s.resolveEdgeAccountID(r.Context(), token)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	// 同一时刻一个 edge 部署（与代理部署独立，互不阻塞）
	s.edge.mu.Lock()
	if s.edge.running {
		s.edge.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "已有盲中继部署正在进行"})
		return
	}
	s.edge.running = true
	s.edge.mu.Unlock()

	client := s.newCFClient(token)
	withDash := true
	if req.WithDashboard != nil {
		withDash = *req.WithDashboard
	}

	go func() {
		defer func() {
			s.edge.mu.Lock()
			s.edge.running = false
			s.edge.mu.Unlock()
			if rec := safe.Recover("盲中继部署"); rec != nil {
				s.logLevel("盲中继部署发生内部错误，详情已记入日志", "err")
				s.events.publish("edge-result", map[string]any{"ok": false, "error": "内部错误，详见日志"})
			}
		}()

		report := func(msg string) { s.logf("[盲中继] " + msg) }
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		defer cancel()

		result, err := edge.Deploy(ctx, client, edge.Options{
			AccountID:         accountID,
			Domain:            strings.TrimSpace(req.Domain),
			WorkerName:        strings.TrimSpace(req.WorkerName),
			MonitorPassword:   req.MonitorPassword,
			MonitorToken:      strings.TrimSpace(req.MonitorToken),
			DashboardProject:  strings.TrimSpace(req.DashboardProject),
			WithDashboard:     withDash,
			ZoneID:            strings.TrimSpace(req.ZoneID),
			AutoDNS:           req.AutoDNS,
			WindowMs:          req.WindowMs,
			MaxBytesPerWindow: req.MaxBytes,
			MaxPackets:        req.MaxPackets,
			MaxPeers:          req.MaxPeers,
			Progress:          report,
		})
		if err != nil {
			s.logLevel("盲中继部署失败："+err.Error(), "err")
			s.events.publish("edge-result", map[string]any{"ok": false, "error": err.Error()})
			return
		}
		s.logLevel("盲中继 / 云监测台部署完成", "ok")
		s.events.publish("edge-result", map[string]any{
			"ok":     true,
			"result": result,
		})
	}()

	writeJSON(w, http.StatusOK, map[string]any{"started": true, "note": "部署已开始，进度通过 SSE 推送"})
}

// handleEdgeCheck 检测账号下已部署的盲中继 / 云监测台实例（只读）。
//
// ⚠️ 只读：只调 GET 类接口 + 对域名做 /health、/auth/status 探测，
// **永不部署、永不写 KV / DNS / Worker**（与「检测账号」同一条纪律）。
// 检测期间若正好有部署在跑，返回 deployInProgress 供界面提示，但不阻断。
func (s *Server) handleEdgeCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	token, err := s.activeTokenOnly()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	accountID, err := s.resolveEdgeAccountID(r.Context(), token)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	// 账号大时每个脚本一次 settings 调用，给足时间但仍要封顶（界面会等这一下）。
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	instances, warnings, derr := edge.Detect(ctx, s.newCFClient(token), accountID, edge.DetectOptions{Probe: true})
	if derr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": derr.Error()})
		return
	}

	s.edge.mu.Lock()
	running := s.edge.running
	s.edge.mu.Unlock()

	if warnings == nil {
		warnings = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"accountId":        accountID,
		"deployInProgress": running,
		"instances":        instances,
		"warnings":         warnings,
	})
}

func (s *Server) handleEdgeZones(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	token, err := s.activeTokenOnly()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	zones, err := s.newCFClient(token).ListZones(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "读取域名列表失败：" + err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(zones))
	for _, z := range zones {
		out = append(out, map[string]any{"id": z.ID, "name": z.Name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"zones": out})
}




