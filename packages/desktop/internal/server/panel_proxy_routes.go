package server

// 「面板请求代理」设置。
//
// ## 为什么需要
//
// 优选结果回填（`POST /api/v1/preferred-ips`）与面板登录（`/api/v1/scanner-token`）
// 都要访问用户自己的**控制面域名**，而它常是 `*.pages.dev` ——
// 该域名在部分网络下直连会被阻断（TLS 握手超时）。
//
// 桌面版能拿到的代理来源只有两处：`HTTP(S)_PROXY` 环境变量（GUI 启动通常没有）
// 与 Windows 系统代理注册表。用户客户端若是「只监听本地端口、不开系统代理」
// （TUN 模式、或手动改了端口），这两个都覆盖不到 —— 于是无论怎么配，
// 回填都走直连。
//
// 所以给一个显式输入：填了就一定用它，与客户端怎么配无关。
// 存在 desktop.json（本机偏好），不进 Worker KV —— 它描述的是这台机器怎么上网，
// 不是部署实例的配置（与 experimental 同一口径）。

import (
	"encoding/json"
	"net/http"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

func (s *Server) registerPanelProxyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/panel-proxy", s.guard(s.handlePanelProxy))
}

// handlePanelProxy 读取 / 保存面板请求代理。
//
// GET  → { ok, proxy（用户填的值）, effective（当前实际会用的来源） }
// POST → { proxy } 保存；空串表示清除（回到自动）
func (s *Server) handlePanelProxy(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		manual, source := scan.PanelProxyStatus()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"proxy":     manual,
			"effective": source,
		})
	case http.MethodPost:
		var body struct {
			Proxy string `json:"proxy"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
			return
		}
		next, err := config.NormalizePanelProxy(body.Proxy)
		if err != nil {
			// 用 200 + ok:false：界面按 ok 判断，400 会被当成「请求本身出错」
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		st := s.Settings()
		st.PanelProxy = next
		if err := config.SaveSettings(st); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "保存失败：" + err.Error()})
			return
		}
		s.mu.Lock()
		s.settings = st
		s.mu.Unlock()
		// 立刻生效：回填/取令牌下一次请求就用新值，不需要重启
		scan.SetPanelProxy(next)

		manual, source := scan.PanelProxyStatus()
		s.logf("面板请求代理已更新：" + describePanelProxy(manual, source))
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"proxy":     manual,
			"effective": source,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
	}
}

// describePanelProxy 把设置状态写成一句人话（日志用）。
func describePanelProxy(manual, source string) string {
	if manual != "" {
		return manual
	}
	if source == "" {
		return "未设置（直连）"
	}
	return "未设置，按 " + source
}
