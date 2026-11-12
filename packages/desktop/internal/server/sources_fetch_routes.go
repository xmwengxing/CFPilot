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

// mergeWithLineBudget 合并多份清单，总行数不超过 budget，
// 返回合并结果与被丢掉的行数。
//
// ## 为什么按来源均摊，而不是直接截断拼接结果
//
// 直接截断等于「只留前几个来源」—— 后面几十个来源的候选全丢，
// 候选多样性被毁掉（而优选正需要多样性：不同来源覆盖不同网段与地区）。
//
// 均摊之后每个来源都留下一部分，覆盖面保住了。
//
// 这些原文最终要进界面那个候选输入框：几万行会让浏览器渲染卡死，
// 且用户每敲一个键都会把整个文本发回后端解析 —— 后端跟着被撑爆。
func mergeWithLineBudget(chunks []string, budget int) (string, int) {
	if len(chunks) == 0 {
		return "", 0
	}
	lines := make([][]string, 0, len(chunks))
	total := 0
	for _, c := range chunks {
		ls := strings.Split(c, "\n")
		lines = append(lines, ls)
		total += len(ls)
	}
	if total <= budget {
		return strings.Join(chunks, "\n"), 0
	}

	// 每个来源先分到 budget/来源数 行，不够的来源把余量让给还有富余的来源。
	perSource := budget / len(chunks)
	taken := make([]int, len(chunks))
	used := 0
	for i, ls := range lines {
		taken[i] = perSource
		if taken[i] > len(ls) {
			taken[i] = len(ls)
		}
		used += taken[i]
	}
	for i, ls := range lines {
		for used < budget && taken[i] < len(ls) {
			taken[i]++
			used++
		}
	}

	merged := make([]string, 0, used)
	kept := 0
	for i, ls := range lines {
		if taken[i] <= 0 {
			continue
		}
		merged = append(merged, ls[:taken[i]]...)
		kept += taken[i]
	}
	return strings.Join(merged, "\n"), total - kept
}

// maxFetchCandidateLines 合并后原文的行数上限。
//
// 这些原文最终要进界面那个候选输入框：几万行会让浏览器渲染卡死，
// 且用户每敲一个键都会把整个文本发回后端解析 —— 后端跟着被撑爆。
//
// 5000 行与自定义候选上限同量级。
const maxFetchCandidateLines = 5000

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
	total := 0
	for _, c := range chunks {
		total += len(scan.ParseCandidateList(c))
	}
	raw, dropped := mergeWithLineBudget(chunks, maxFetchCandidateLines)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        len(chunks) > 0,
		"raw":       raw,
		"count":     len(scan.ParseCandidateList(raw)),
		"total":     total,
		"selected":  len(ids),
		"truncated": truncated,
		"dropped":   dropped,
		"errors":    errors,
	})
}
