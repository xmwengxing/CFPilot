package server

// Phase 5 · 桌面版「外部 IP 数据源」管理页的 HTTP API。
//
// 这是本功能**唯一的 UI 入口**：Cloudflare 面板 panel.html 零改动。
// 所有数据都只落在 ~/.cfpilot 的本地池与配置里；唯一会写 KV 的动作是
// /api/sources/quick 触发的完整优选（走既有 PostResults，默认 replace）。
//
// 路由一律用 `mux.HandleFunc("/api/...")` 字面量注册 ——
// scripts/check-ui-integration.mjs 会扫这些字面量与 adapter.js 做双向核对。

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

func (s *Server) registerSourcesRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/sources/list", s.guard(s.handleSourcesList))
	mux.HandleFunc("/api/sources/save", s.guard(s.handleSourcesSave))
	mux.HandleFunc("/api/sources/test", s.guard(s.handleSourcesTest))
	mux.HandleFunc("/api/sources/sync", s.guard(s.handleSourcesSync))
	mux.HandleFunc("/api/sources/status", s.guard(s.handleSourcesStatus))
	mux.HandleFunc("/api/sources/pool", s.guard(s.handleSourcesPool))
	mux.HandleFunc("/api/sources/pool/update", s.guard(s.handleSourcesPoolUpdate))
	mux.HandleFunc("/api/sources/quick", s.guard(s.handleSourcesQuick))
}

func (s *Server) handleSourcesList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 GET"})
		return
	}
	cfg := scan.LoadSources()
	pool := scan.ParsePool(scan.ReadPoolRaw())
	byStatus := map[string]int{}
	byFamily := map[string]int{}
	for _, c := range pool.Candidates {
		byStatus[string(c.Status)]++
		if c.IPVersion == 6 {
			byFamily["v6"]++
		} else {
			byFamily["v4"]++
		}
	}
	running, lastRun, lastErr := s.SourceSchedulerStatus()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"config": cfg,
		"pool": map[string]any{
			"total": len(pool.Candidates), "byStatus": byStatus,
			"byFamily": byFamily, "updatedAt": pool.UpdatedAt,
		},
		"scheduler": map[string]any{
			"running": running, "lastRun": lastRun, "lastError": lastErr,
		},
	})
}

// validateSourcesConfig 在落盘前做 URL / id / 类型 / query 校验，挡住私网 SSRF 与脏数据。
func validateSourcesConfig(cfg *scan.SourcesFile) error {
	seen := map[string]bool{}
	for i := range cfg.Sources {
		src := &cfg.Sources[i]
		src.ID = strings.TrimSpace(src.ID)
		if src.ID == "" {
			return errString("数据源 id 不能为空")
		}
		if seen[src.ID] {
			return errString("数据源 id 重复：" + src.ID)
		}
		seen[src.ID] = true
		switch src.Type {
		case scan.SourceTypeGitHubRaw, scan.SourceTypeCustomURL:
			if _, err := scan.ValidateSourceURL(src.URL, false); err != nil {
				return err
			}
			for _, m := range src.Mirrors {
				if _, err := scan.ValidateSourceURL(m, false); err != nil {
					return err
				}
			}
		case scan.SourceTypeRipeStat:
			// API 型的 endpoint 由 Provider 固定，配置里不该带 URL
			src.URL = ""
			src.Mirrors = []string{}
			if strings.TrimSpace(src.Query) == "" {
				src.Query = scan.DefaultProviderQuery(src.Type)
			}
			if src.Type == scan.SourceTypeRipeStat &&
				!regexp.MustCompile(`(?i)^AS\d{1,10}$`).MatchString(strings.TrimSpace(src.Query)) {
				return errString("ripe-stat 的 query 必须是 ASN（如 AS13335）：" + src.ID)
			}
		default:
			return errString("数据源类型只支持 github-raw / custom-url / ripe-stat：" + src.ID)
		}
		if src.Name == "" {
			src.Name = src.ID
		}
		if src.IntervalHours <= 0 {
			src.IntervalHours = 24
			if src.Type == scan.SourceTypeGitHubRaw {
				src.IntervalHours = 12
			}
		}
		if src.Mirrors == nil {
			src.Mirrors = []string{}
		}
		if src.MaxResults <= 0 || src.MaxResults > 2000 {
			src.MaxResults = 200
		}
	}
	return nil
}

// 小工具：把字符串包成 error，避免为一句校验到处 import fmt/errors。
type sourceErr string

func (e sourceErr) Error() string { return string(e) }

func errString(msg string) error { return sourceErr(msg) }

func (s *Server) handleSourcesSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var body struct {
		Config *scan.SourcesFile `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Config == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体不是合法的配置 JSON"})
		return
	}
	cfg := body.Config
	cfg.Schema = scan.SourcesSchema
	if cfg.Sources == nil {
		cfg.Sources = []scan.SourceConfig{}
	}
	if cfg.Runs == nil {
		cfg.Runs = []scan.SyncRun{}
	}
	if err := validateSourcesConfig(cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if err := scan.SaveSources(cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": scan.LoadSources()})
}

func (s *Server) handleSourcesTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体不是合法 JSON"})
		return
	}
	cfg := scan.LoadSources()
	var target *scan.SourceConfig
	for i := range cfg.Sources {
		if cfg.Sources[i].ID == body.ID {
			t := cfg.Sources[i]
			target = &t
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "数据源不存在：" + body.ID})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if scan.IsAPISource(*target) {
		// API 型源走 Provider，且「测试」不写池、不改配置
		res, err := scan.RunProvider(ctx, *target, scan.ProviderOptions{TimeoutMS: 20000})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"outcome": map[string]any{
				"sourceId": target.ID, "ok": true, "added": len(res.Candidates),
				"note": res.Note, "upstreamCount": res.UpstreamCount,
			},
		})
		return
	}
	outcome := scan.TestSource(ctx, *target, scan.SyncOptions{})
	writeJSON(w, http.StatusOK, map[string]any{"ok": outcome.OK, "outcome": outcome})
}

func (s *Server) handleSourcesSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	// 空 body 合法（同步全部）
	_ = json.NewDecoder(r.Body).Decode(&body)
	ids := map[string]bool{}
	for _, id := range body.IDs {
		if strings.TrimSpace(id) != "" {
			ids[strings.TrimSpace(id)] = true
		}
	}
	if len(ids) == 0 {
		ids = nil
	}
	// 与一键优选同理：用 Background，用户关掉页面不该让同步被静默取消
	report, err := s.SyncSourcesNow(context.Background(), ids)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "report": report})
}

func (s *Server) handleSourcesStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 GET"})
		return
	}
	running, lastRun, lastErr := s.SourceSchedulerStatus()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "running": running, "lastRun": lastRun, "lastError": lastErr,
	})
}

func (s *Server) handleSourcesPool(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 GET"})
		return
	}
	pool := scan.ParsePool(scan.ReadPoolRaw())
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "updatedAt": pool.UpdatedAt, "candidates": pool.Candidates,
	})
}

func (s *Server) handleSourcesPoolUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var body struct {
		Keys   []string `json:"keys"`
		Action string   `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体不是合法 JSON"})
		return
	}
	if body.Action != "disable" && body.Action != "enable" && body.Action != "delete" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "action 只支持 disable / enable / delete"})
		return
	}
	keys := map[string]bool{}
	for _, k := range body.Keys {
		keys[k] = true
	}
	changed := 0
	err := scan.WithPool(func(pool *scan.ExternalPool) error {
		if body.Action == "delete" {
			kept := make([]scan.ExternalCandidate, 0, len(pool.Candidates))
			for _, c := range pool.Candidates {
				if keys[c.Key] {
					changed++
					continue
				}
				kept = append(kept, c)
			}
			pool.Candidates = kept
		} else {
			for i := range pool.Candidates {
				if !keys[pool.Candidates[i].Key] {
					continue
				}
				if body.Action == "disable" && pool.Candidates[i].Status != scan.StatusDisabled {
					pool.Candidates[i].Status = scan.StatusDisabled
					changed++
				} else if body.Action == "enable" && pool.Candidates[i].Status == scan.StatusDisabled {
					pool.Candidates[i].Status = scan.StatusPending
					changed++
				}
			}
		}
		pool.UpdatedAt = time.Now().UnixMilli()
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "changed": changed})
}

func (s *Server) handleSourcesQuick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var body struct {
		PoolSample int `json:"poolSample"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res := s.RunQuickScanWithPool(ctx, QuickScanPoolOptions{
		FromPool: true, PoolSample: body.PoolSample,
	})
	writeJSON(w, http.StatusOK, res)
}
