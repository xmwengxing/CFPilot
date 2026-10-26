package server

// 本文件实现「检查更新」API。
//
// ## 与 Electron 版的对应关系
//
//	window.cfpilot.checkUpdate()      → POST /api/update/check
//	window.cfpilot.downloadUpdate(url) → POST /api/update/download
//
// 「安装更新」在 Go 版有本质区别：
//   - Electron 版：下载 portable exe 后写一个 .cmd 脚本，等进程退出后替换自己
//   - Go 版：程序是单个二进制，同样无法覆盖自己（Windows 会锁文件）
//
// 因此 Go 版的做法是：
//   1. 下载到配置目录的 updates/ 下
//   2. 提示用户手动替换（界面给出文件路径 + 一键「打开所在目录」）
//
// **不做自动替换**是有意的：自动替换自己不署名的二进制风险更高
// （下载被镜像篡改就无法察觉），让用户手动替换至少是一次显式确认。

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

// registerUpdateRoutes 挂载更新相关路由。
func (s *Server) registerUpdateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/update/check", s.guard(s.handleUpdateCheck))
	mux.HandleFunc("/api/update/download", s.guard(s.handleUpdateDownload))
	mux.HandleFunc("/api/update/reveal", s.guard(s.handleUpdateReveal))
}

// handleUpdateCheck 检查是否有新版本。
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	res := update.Check(ctx, Version())
	if res.Error != "" {
		s.logLevel("检查更新失败："+res.Error, "warn")
	}
	if res.HasUpdate {
		s.logLevel("发现新版本 "+res.Latest+"（当前 "+res.Current+"）", "ok")
	} else if res.Error == "" {
		s.logf("已是最新版本（" + res.Current + "）")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"current":     res.Current,
		"latest":      res.Latest,
		"hasUpdate":   res.HasUpdate,
		"downloadUrl": res.DownloadURL,
		"notes":       res.Notes,
		"error":       res.Error,
	})
}

// handleUpdateDownload 下载新版本（异步，进度走 SSE）。
func (s *Server) handleUpdateDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		URL     string `json:"url"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	if strings.TrimSpace(req.URL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少下载地址"})
		return
	}

	version := strings.TrimSpace(req.Version)
	if version == "" {
		version = "latest"
	}
	target := update.DefaultDownloadPath(version)

	// 同一时刻只允许一个下载
	s.update.mu.Lock()
	if s.update.running {
		s.update.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "已有下载正在进行"})
		return
	}
	s.update.running = true
	s.update.mu.Unlock()

	go func() {
		defer func() {
			s.update.mu.Lock()
			s.update.running = false
			s.update.mu.Unlock()
		}()

		file, err := update.Download(
			context.Background(),
			req.URL,
			target,
			func(p update.Progress) {
				// 进度走 SSE 的 update-progress 事件（与 Electron 版同构）
				s.events.publish("update-progress", map[string]any{
					"received": p.Received,
					"total":    p.Total,
					"source":   p.Source,
					"attempt":  p.Attempt,
				})
			},
			func(msg, level string) { s.logLevel(msg, level) },
		)
		if err != nil {
			s.logLevel("下载失败："+err.Error(), "err")
			s.events.publish("update-done", map[string]any{"ok": false, "error": err.Error()})
			return
		}

		s.logLevel("新版本已下载到 "+file, "ok")
		s.logf("请手动用新文件替换当前程序（替换前先退出 CFPilot）")
		s.events.publish("update-done", map[string]any{
			"ok":   true,
			"file": file,
			"note": "下载完成，请退出程序后手动替换",
		})
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"started": true,
		"target":  target,
		"note":    "下载已开始，进度会通过 SSE 实时推送",
	})
}

// handleUpdateReveal 在文件管理器里打开下载目录。
//
// 下载完成后用户需要手动替换，所以必须能一键定位到文件。
func (s *Server) handleUpdateReveal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		File string `json:"file"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	dir := ""
	if strings.TrimSpace(req.File) != "" {
		dir = filepath.Dir(req.File)
	} else {
		// 没给文件就用默认下载目录
		dir = filepath.Dir(update.DefaultDownloadPath("latest"))
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "无法打开文件管理器：" + err.Error(),
			"path":  dir,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": dir})
}
