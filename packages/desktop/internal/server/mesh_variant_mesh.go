//go:build mesh

package server

import (
	"io"
	"net/http"
	"time"
)

// meshdAddr 是提权守护进程的本地 API 地址（安装时注册为服务）。
const meshdAddr = "http://127.0.0.1:19727"

// registerMeshControlRoutes 把面板/托盘的 mesh 控制请求转发到提权守护进程 meshd。
//
// 设计：面板 server 已带 guard（Session Cookie + Host/Origin 校验），
// 所以这里复用 s.guard，再把请求原样转给 meshd（普通进程不碰 TUN，提权只在 meshd）。
func (s *Server) registerMeshControlRoutes(mux *http.ServeMux) {
	for _, p := range []string{
		"/api/mesh/status", "/api/mesh/start", "/api/mesh/stop", "/api/mesh/peers",
	} {
		mux.HandleFunc(p, s.guard(s.handleMeshProxy))
	}
}

func (s *Server) handleMeshProxy(w http.ResponseWriter, r *http.Request) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(r.Method, meshdAddr+r.URL.Path, r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "构造请求失败: " + err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "mesh 守护进程未运行（请先安装并启动 +mesh 服务）: " + err.Error(),
		})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

// meshVariantEnabled 返回当前构建是否启用 +mesh 组网变体（+mesh 版）。
func meshVariantEnabled() bool { return true }

func (s *Server) handleMeshEnabled(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true})
}
