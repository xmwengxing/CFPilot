//go:build mesh

package server

import "net/http"

// meshVariantEnabled 返回当前构建是否启用 +mesh 组网变体（+mesh 版）。
func meshVariantEnabled() bool { return true }

func (s *Server) handleMeshEnabled(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true})
}
