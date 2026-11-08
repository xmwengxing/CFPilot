package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// handleQualityEgress 识别**本机网络**的出口（实验性、显式触发）。
//
// ⚠️ 口径红线：这测的是桌面版所在网络的直连/SOCKS5 出口，**不是候选 IP 的出口**。
// 报告里必须如此标注，不得宣称为逐候选入口的差异（见 scan.IdentifyEgress）。
//
// 请求体：{ sessionId, ip, port, serviceUrl, bearerToken?, socks5Proxy? }
// 凭据（token/代理）只用于本次请求，不落盘、不写日志。
func (s *Server) handleQualityEgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		SessionID   string `json:"sessionId"`
		IP          string `json:"ip"`
		Port        int    `json:"port"`
		ServiceURL  string `json:"serviceUrl"`
		BearerToken string `json:"bearerToken"`
		SOCKS5Proxy string `json:"socks5Proxy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	id := strings.TrimSpace(req.SessionID)
	ip := strings.TrimSpace(req.IP)
	if id == "" || net.ParseIP(ip) == nil || req.Port < 1 || req.Port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "需要合法的 sessionId、IP 与端口"})
		return
	}
	if strings.TrimSpace(req.ServiceURL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "需要提供出口识别服务 URL（HTTPS）"})
		return
	}

	result, err := scan.IdentifyEgress(context.Background(), scan.EgressIdentityOptions{
		ServiceURL:     strings.TrimSpace(req.ServiceURL),
		BearerToken:    req.BearerToken,
		SOCKS5ProxyURL: strings.TrimSpace(req.SOCKS5Proxy),
	})
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	age := result.AgeMs
	report := history.QualityReport{
		Version: 1,
		IP:      ip,
		Port:    req.Port,
		Egress: history.QualityEgress{
			Transport:  result.Transport,
			RemoteIP:   result.RemoteIP,
			ObservedAt: result.ObservedAt.Format(time.RFC3339Nano),
			AgeMs:      &age,
			EgressKind: result.EgressKind,
			Colo:       result.Colo,
			Status:     "observed",
		},
	}
	if err := s.historyStore().SaveQualityReport(id, report); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "egress": report.Egress, "port": strconv.Itoa(req.Port)})
}
