package server

// 优选历史与单 IP 复测 API。
//
//	window.cfpilot.getScanHistory()   → GET    /api/scan/history
//	window.cfpilot.deleteScanHistory(id) → DELETE /api/scan/history?id=...
//	window.cfpilot.reTestIps(params)  → POST   /api/scan/re-test
//
// ## 为什么要做历史
//
// 优选结果是「某一时刻」的快照：页面一刷新就没了，用户只能重跑（几分钟）。
// 留底之后可以：跨天对比、多选复制、对旧结果里的 IP 二次复测确认可用性。
//
// ## 自动保存
//
// 本地真连接优选（/api/scan/run）与一键优选（/api/scan/quick）成功后
// 由**后端**自动写历史（见 scan_routes.go / scan_quick.go 里的 saveScanHistory 调用），
// 前端只读不写 —— 单一事实来源，避免双写竞态。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// maxReTestTargets 是单次复测的 IP 数上限。
//
// 复测是给「从历史里勾选的几条」用的，不是批量扫描器 —— 上限挡住误用。
const maxReTestTargets = 100

// historyStore 按当前凭据库目录构造历史库（每次现建：目录可被测试注入）。
func (s *Server) historyStore() *history.Store {
	return history.New(s.store.DirPath(), history.DefaultCap)
}

// saveScanHistory 把一次成功的优选写入历史（失败只记日志，不影响主流程）。
func (s *Server) saveScanHistory(source, host, wsPath, probePath string, skipSpeed bool, entries []scan.Entry) {
	if len(entries) == 0 {
		return
	}
	st := s.historyStore()
	sess := history.Session{
		At:        time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Host:      host,
		WSPath:    wsPath,
		ProbePath: probePath,
		SkipSpeed: skipSpeed,
		Source:    source,
		Entries:   history.FromScanEntries(entries),
	}
	if err := st.Save(sess); err != nil {
		s.logLevel("保存优选历史失败："+err.Error(), "warn")
	}
}

// handleScanHistory 读取 / 删除优选历史。
//
// GET            → { sessions: [...] }（最新在前）
// DELETE ?id=... → { ok: true }
func (s *Server) handleScanHistory(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list, err := s.historyStore().Load()
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "读取优选历史失败：" + err.Error()})
			return
		}
		if list == nil {
			list = []history.Session{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessions": list})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少 id 参数"})
			return
		}
		if err := s.historyStore().Delete(id); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "删除失败：" + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET / DELETE"})
	}
}

// handleScanReTest 对选中的 IP 跑分层可用性复测。
//
// 请求体：
//
//	{
//	  sessionId: "..."          // 可选：传了就把复测结论写回该会话条目
//	  host, wsPath, probePath,  // 用历史会话里保存的参数（不是当前表单）
//	  withSpeed: bool           // 是否带真实下行测速（慢）
//	  targets: [{ip, port}]
//	}
//
// 响应：{ ok: true, results: [IPTestResult...] }（顺序与 targets 一致）
func (s *Server) handleScanReTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		SessionID string            `json:"sessionId"`
		Host      string            `json:"host"`
		WSPath    string            `json:"wsPath"`
		ProbePath string            `json:"probePath"`
		WithSpeed bool              `json:"withSpeed"`
		Targets   []scan.TestTarget `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	host := strings.TrimSpace(req.Host)
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "缺少域名：复测需要用历史会话里保存的数据面域名做 TLS SNI / HTTP Host",
		})
		return
	}
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimSuffix(host, "/")

	if len(req.Targets) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "没有选择要复测的 IP"})
		return
	}
	if len(req.Targets) > maxReTestTargets {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("一次最多复测 %d 个 IP（当前 %d 个）", maxReTestTargets, len(req.Targets)),
		})
		return
	}

	// ⚠️ 不能绑 r.Context()：复测在响应返回前同步完成，请求断开就全废。
	// 用独立 context + 总预算（带测速时每个 IP 最长 ~8 秒，100 个 / 16 并发 ≈ 1 分钟，取 4 分钟兜底）。
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	s.logf(fmt.Sprintf("开始复测 %d 个 IP（域名 %s，%s测速）",
		len(req.Targets), host, map[bool]string{true: "带", false: "不带"}[req.WithSpeed]))

	results := scan.TestIPs(ctx, req.Targets, scan.TestOptions{
		Host:      host,
		WSPath:    req.WSPath,
		ProbePath: req.ProbePath,
		WithSpeed: req.WithSpeed,
	})

	okCount := 0
	for _, res := range results {
		if res.OK {
			okCount++
		}
	}
	s.logf(fmt.Sprintf("复测完成：%d/%d 可用", okCount, len(results)))

	// 把复测结论写回历史会话（找得到才写；失败不影响响应）
	if sid := strings.TrimSpace(req.SessionID); sid != "" {
		if err := s.historyStore().UpdateEntryLastTest(sid, results); err != nil {
			s.logLevel("写回复测结论失败："+err.Error(), "warn")
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "results": results})
}
