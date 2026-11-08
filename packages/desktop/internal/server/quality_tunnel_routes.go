package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// maxCompatTargets 是单次兼容性检测的目标数上限（与 CLI WEBSITE_MAX_TARGETS 对齐）。
const maxCompatTargets = 10

// parseTargetSpec 解析「host[:port]/path」：缺省端口按 path 前有无 : 推断 443。
func parseTargetSpec(raw string) (scan.TunnelWebsiteTarget, error) {
	raw = strings.TrimSpace(raw)
	slash := strings.Index(raw, "/")
	if slash < 0 {
		return scan.TunnelWebsiteTarget{}, errors.New("缺少路径")
	}
	hostPort, path := raw[:slash], raw[slash:]
	host := hostPort
	port := 443
	if h, p, err := net.SplitHostPort(hostPort); err == nil {
		host = h
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return scan.TunnelWebsiteTarget{}, errors.New("端口无效")
		}
		port = n
	}
	return scan.TunnelWebsiteTarget{Host: host, Port: port, Path: path}, nil
}

type tunnelCreds struct {
	UUID             string `json:"uuid"`
	TrojanPassword   string `json:"trojanPassword"`
	VerifyTargetHost string `json:"verifyTargetHost"`
	VerifyTargetPort int    `json:"verifyTargetPort"`
}

// handleQualityCompat 穿候选隧道检测目标站兼容性（实验性、显式触发）。
func (s *Server) handleQualityCompat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		IP        string `json:"ip"`
		Port      int    `json:"port"`
		Host      string `json:"host"`
		WSPath    string `json:"wsPath"`
		tunnelCreds
		Targets []struct {
			Label        string `json:"label"`
			Spec         string `json:"spec"`
			ExpectedText string `json:"expectedText"`
		} `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	id := strings.TrimSpace(req.SessionID)
	ip := strings.TrimSpace(req.IP)
	host := strings.TrimSpace(req.Host)
	host = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://"), "/")
	if id == "" || net.ParseIP(ip) == nil || req.Port < 1 || req.Port > 65535 || host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "需要合法的 sessionId、IP、端口与数据面域名"})
		return
	}
	if len(req.Targets) < 1 || len(req.Targets) > maxCompatTargets {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "需要 1-10 个目标站"})
		return
	}
	if strings.TrimSpace(req.UUID) == "" && strings.TrimSpace(req.TrojanPassword) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "兼容性检测需要隧道凭据（UUID 或 Trojan 密码）"})
		return
	}
	seen := map[string]bool{}
	var targets []scan.TunnelWebsiteTarget
	for _, t := range req.Targets {
		label := strings.TrimSpace(t.Label)
		if label == "" || seen[label] {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "目标标签不能为空且不能重复"})
			return
		}
		seen[label] = true
		spec, err := parseTargetSpec(t.Spec)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "目标格式应为 host[:port]/path：" + label})
			return
		}
		spec.Label = label
		spec.ExpectedText = t.ExpectedText
		targets = append(targets, spec)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	opt := scan.TunnelProbeOptions{
		IP: ip, Port: req.Port, Host: host, WSPath: req.WSPath,
		UUID: strings.TrimSpace(req.UUID), TrojanPassword: strings.TrimSpace(req.TrojanPassword),
	}
	compat := history.QualityCompatibility{Targets: []history.CompatibilityTarget{}, Status: "available"}
	for _, t := range targets {
		r := scan.ProbeTunnelWebsite(ctx, opt, t)
		challengeHeader := ""
		if r.ChallengeHeader {
			challengeHeader = "challenge"
		}
		ct := history.CompatibilityTarget{
			URLLabel:          t.Label,
			Status:            r.Status,
			HTTPStatus:        &r.HTTPStatus,
			ChallengeHeader:   challengeHeader,
			Ms:                &r.Ms,
			ExpectedContentOK: r.ExpectedContentOK,
			Error:             r.Error,
		}
		compat.Targets = append(compat.Targets, ct)
	}
	if err := s.historyStore().SaveQualityReport(id, history.QualityReport{
		Version: 1, IP: ip, Port: req.Port, Compatibility: compat,
	}); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "compatibility": compat})
}

// handleQualityTunnelEgress 穿候选隧道识别**候选出口**（实验性、显式触发）。
func (s *Server) handleQualityTunnelEgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		IP        string `json:"ip"`
		Port      int    `json:"port"`
		Host      string `json:"host"`
		WSPath    string `json:"wsPath"`
		tunnelCreds
		ServiceURL string `json:"serviceUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	id := strings.TrimSpace(req.SessionID)
	ip := strings.TrimSpace(req.IP)
	host := strings.TrimSpace(req.Host)
	host = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://"), "/")
	if id == "" || net.ParseIP(ip) == nil || req.Port < 1 || req.Port > 65535 || host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "需要合法的 sessionId、IP、端口与数据面域名"})
		return
	}
	if strings.TrimSpace(req.ServiceURL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "需要提供出口识别服务 URL（HTTPS）"})
		return
	}
	if strings.TrimSpace(req.UUID) == "" && strings.TrimSpace(req.TrojanPassword) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "隧道出口识别需要隧道凭据（UUID 或 Trojan 密码）"})
		return
	}
	result, err := scan.IdentifyTunnelEgress(context.Background(), scan.TunnelProbeOptions{
		IP: ip, Port: req.Port, Host: host, WSPath: req.WSPath,
		UUID: strings.TrimSpace(req.UUID), TrojanPassword: strings.TrimSpace(req.TrojanPassword),
	}, strings.TrimSpace(req.ServiceURL))
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "egress": report.Egress})
}
