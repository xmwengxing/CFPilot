package server

// 实验性功能开关（默认全部关闭）。
//
// ## 为什么单独一个文件
//
// 这些能力会**改变优选行为**，属于「用户显式选择才生效」的部分：
//   - 自适应网段权重：按本机网络档案的历史成败调整采样权重
//
// 开关存放在 desktop.json（本地设置），**不进 Worker KV**：
// 它描述的是「这台机器上的使用偏好」，不是部署实例的配置。
// 一个 KV 对应一个部署实例，把个人偏好写进去只会污染实例配置。

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
)

// experimentalRequest 是开关的读写载荷。
type experimentalRequest struct {
	AdaptiveSampling bool    `json:"adaptiveSampling"`
	ExploreRatio     float64 `json:"exploreRatio"`
	ISP              string  `json:"isp"`
	Region           string  `json:"region"`
	Access           string  `json:"access"`
}

// normalizeExperimental 校正开关取值。
//
// 探索比例限制在 0~1；运营商/接入类型只接受已知枚举值，
// 避免拼错档案身份导致历史被切成两半（不同档案不共享历史）。
func normalizeExperimental(in config.ExperimentalSettings) config.ExperimentalSettings {
	out := in
	if out.ExploreRatio <= 0 || out.ExploreRatio > 1 {
		out.ExploreRatio = 0.2
	}
	out.ISP = strings.ToLower(strings.TrimSpace(out.ISP))
	switch out.ISP {
	case "ct", "cu", "cm", "other":
	default:
		out.ISP = "other"
	}
	out.Region = strings.TrimSpace(out.Region)
	if len(out.Region) > 32 {
		out.Region = out.Region[:32]
	}
	out.Access = strings.ToLower(strings.TrimSpace(out.Access))
	switch out.Access {
	case "fixed", "mobile":
	default:
		out.Access = "fixed"
	}
	return out
}

func (s *Server) registerExperimentalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/experimental", s.guard(s.handleExperimental))
}

// handleExperimental 读取 / 保存实验性功能开关。
//
// GET  → 当前开关
// POST → 保存（只改 experimental 段，其它设置不动）
func (s *Server) handleExperimental(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"experimental": normalizeExperimental(s.Settings().Experimental),
		})
	case http.MethodPost:
		var body experimentalRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
			return
		}
		next := s.Settings()
		next.Experimental = normalizeExperimental(config.ExperimentalSettings{
			AdaptiveSampling: body.AdaptiveSampling,
			ExploreRatio:     body.ExploreRatio,
			ISP:              body.ISP,
			Region:           body.Region,
			Access:           body.Access,
		})
		if err := config.SaveSettings(next); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "保存失败：" + err.Error()})
			return
		}
		s.mu.Lock()
		s.settings = next
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"experimental": next.Experimental,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
	}
}
