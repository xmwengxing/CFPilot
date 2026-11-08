package server

// 「加载数据源清单」弹窗的后端：按选中的来源 ID 拉取原始清单并合并。
//
// 与 /api/sources/sync 的区别：这里不写本地池、不过滤候选、不要求来源已启用，
// 只把清单原文交给前端填进候选输入框。解析与校验统一交给
// /api/scan/parse-candidates（ParseCandidateList，IP 与域名都认）。

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// 一次最多拉 30 个来源：弹窗全选也不该把出站请求打满。
const maxFetchSelectedSources = 30

func (s *Server) handleSourcesFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体不是合法 JSON"})
		return
	}

	seen := map[string]bool{}
	ids := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有选中任何数据源"})
		return
	}
	truncated := len(ids) > maxFetchSelectedSources
	if truncated {
		ids = ids[:maxFetchSelectedSources]
	}

	cfg := scan.LoadSources()
	byID := make(map[string]scan.SourceConfig, len(cfg.Sources))
	for _, src := range cfg.Sources {
		byID[src.ID] = src
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	type fetched struct {
		text string
		err  string
	}
	results := make([]fetched, len(ids))
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			src, ok := byID[id]
			if !ok {
				results[i] = fetched{err: "数据源不存在：" + id}
				return
			}
			if scan.IsAPISource(src) {
				results[i] = fetched{err: src.Name + " 是 API 型来源，不提供清单文本"}
				return
			}
			res, err := scan.FetchSourceText(ctx, src, scan.SourceFetchOptions{TimeoutMS: 8000})
			if err != nil {
				results[i] = fetched{err: src.Name + "：" + err.Error()}
				return
			}
			results[i] = fetched{text: res.Text}
		}(i, id)
	}
	wg.Wait()

	chunks := make([]string, 0, len(results))
	errors := make([]string, 0)
	for _, one := range results {
		if one.err != "" {
			errors = append(errors, one.err)
			continue
		}
		if t := strings.TrimSpace(one.text); t != "" {
			chunks = append(chunks, t)
		}
	}
	raw := strings.Join(chunks, "\n")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        len(chunks) > 0,
		"raw":       raw,
		"count":     len(scan.ParseCandidateList(raw)),
		"selected":  len(ids),
		"truncated": truncated,
		"errors":    errors,
	})
}
