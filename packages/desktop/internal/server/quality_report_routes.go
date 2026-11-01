package server

import (
	"net"
	"net/http"
	"strconv"
	"strings"
)

// handleIPQualityReport 只读取本地证据；查看报告不触发网络探测。
func (s *Server) handleIPQualityReport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 GET"})
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("sessionId"))
	ip := strings.TrimSpace(r.URL.Query().Get("ip"))
	port, err := strconv.Atoi(r.URL.Query().Get("port"))
	if id == "" || len(id) > 256 || net.ParseIP(ip) == nil || err != nil || port < 1 || port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "需要合法的 sessionId、IP 与端口"})
		return
	}
	report, err := s.historyStore().QualityReport(id, ip, port)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "report": report})
}
