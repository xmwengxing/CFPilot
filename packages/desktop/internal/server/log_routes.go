package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/logfile"
)

// 日志浏览接口：
//
//	GET /api/logs?tail=500
//
// 供界面的「日志」页签使用。
//
// ⚠️ 只监听 127.0.0.1，且走 guard()（需要会话）——
// 日志里可能含 IP、路径、错误详情，不应被任意网页读到。
func (s *Server) registerLogRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/logs", s.guard(s.handleLogs))
}

// handleLogs 返回日志尾部内容与文件信息。
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}

	tail := 500
	if v := strings.TrimSpace(r.URL.Query().Get("tail")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			tail = n
		}
	}
	// 上限：一次别拉太多（几百 KB 的 JSON 会卡住界面）
	if tail > 5000 {
		tail = 5000
	}

	path := s.logFilePath()
	lines, total, err := logfile.Tail(path, tail)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok":    false,
			"error": "读取日志失败：" + err.Error(),
		})
		return
	}

	var size int64
	if st, statErr := os.Stat(path); statErr == nil {
		size = st.Size()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"path":      path,
		"size":      size,
		"sizeText":  logfile.HumanSize(size),
		"lines":     lines,
		"total":     total,
		"truncated": total > len(lines),
		"rotated":   logfile.RotatedFiles(path, logfile.DefaultMaxBackups),
	})
}

// logFilePath 返回日志文件路径（与 cmd/cfpilot 写日志用的是同一个）。
func (s *Server) logFilePath() string {
	dir, err := config.Dir()
	if err != nil {
		return "cfpilot.log"
	}
	return filepath.Join(dir, "cfpilot.log")
}
