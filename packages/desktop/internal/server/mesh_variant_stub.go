//go:build !mesh

package server

import "net/http"

// 普通版未启用 +mesh 变体。
func meshVariantEnabled() bool { return false }

// variantName 是界面用来区分产物的构建变体标识。
func variantName() string { return "standard" }

func (s *Server) handleMeshEnabled(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
}

// 普通版不注册 mesh 控制路由。
func (s *Server) registerMeshControlRoutes(mux *http.ServeMux) {}
