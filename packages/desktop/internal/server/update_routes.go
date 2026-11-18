package server

// 本文件实现「检查更新」API。
//
// ## 更新流程（2026-11-15 自动化）
//
//	window.cfpilot.checkUpdate()      → POST /api/update/check    检查
//	window.cfpilot.downloadUpdate(url) → POST /api/update/download 自动下载到缓存
//	window.cfpilot.applyUpdate(file)   → POST /api/update/apply    重启并更新
//
// 「重启并更新」的实现（rename-swap，见 internal/update/apply.go）：
//
//	1. 下载完成时产物已按官方 SHA256SUMS 校验，本地哈希写入 .sha256 sidecar
//	2. 用户点「重启并更新」→ 再验 sidecar → rename-swap 当前 exe
//	3. spawn helper（新版 exe 自己）：等旧进程退出 → 删 .old → 正常重启
//	4. 主进程退出，浏览器重新打开新进程的面板（新进程会发系统通知）
//
// 旧版（提示用户手动替换）已被自动化取代：哈希校验 fail-closed
//（sidecar 缺失 / 不符一律拒绝），安全性不因自动化而降低。

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

// registerUpdateRoutes 挂载更新相关路由。
func (s *Server) registerUpdateRoutes(mux *http.ServeMux) {
	if meshVariantEnabled() {
		// +mesh 版是 NSIS 安装包形态，不能 rename-swap 自我替换；
		// 且两变体共用 tag / SHA256SUMS，按 OS+arch 选资产会串变体。
		// 所以只暴露一个「请用安装包升级」的提示，不执行真实检查/下载/替换。
		stub := func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": false, "error": "+mesh 版请用最新安装包重新安装升级（不支持应用内自动更新）",
			})
		}
		mux.HandleFunc("/api/update/check", s.guard(stub))
		mux.HandleFunc("/api/update/download", s.guard(stub))
		mux.HandleFunc("/api/update/apply", s.guard(stub))
		mux.HandleFunc("/api/update/reveal", s.guard(stub))
		return
	}
	mux.HandleFunc("/api/update/check", s.guard(s.handleUpdateCheck))
	mux.HandleFunc("/api/update/download", s.guard(s.handleUpdateDownload))
	mux.HandleFunc("/api/update/apply", s.guard(s.handleUpdateApply))
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
		// 下载时已按官方 SHA256SUMS 校验；把本地哈希写进 sidecar，
		// 「重启并更新」时会再验一次（防「下载后到点击前」被改动）。
		if err := update.WriteSidecarSHA256(file); err != nil {
			s.logLevel("⚠ 写下载校验记录失败（将无法一键更新）："+err.Error(), "warn")
		}
		s.logf("点击「重启并更新应用」即可完成更新，无需手动替换")
		s.events.publish("update-done", map[string]any{
			"ok":   true,
			"file": file,
			"note": "下载完成，点击「重启并更新应用」即可自动替换并重启",
		})
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"started": true,
		"target":  target,
		"note":    "下载已开始，进度会通过 SSE 实时推送",
	})
}

// handleUpdateApply 「重启并更新应用」：校验 → rename-swap → spawn helper → 退出。
//
// ⚠️ 时序敏感：swap 完成后必须**先发响应**再退出主进程 ——
// 响应写不回去的话界面只会看到请求失败。所以退出放在
// 响应写出之后的 goroutine 里延迟执行。
func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		File string `json:"file"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if strings.TrimSpace(req.File) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少新版本文件路径（请先下载更新）"})
		return
	}

	s.update.mu.Lock()
	if s.update.running {
		s.update.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "已有更新流程进行中"})
		return
	}
	s.update.running = true
	s.update.mu.Unlock()

	oldPath, err := update.ApplyUpdate(req.File)
	if err != nil {
		s.update.mu.Lock()
		s.update.running = false
		s.update.mu.Unlock()
		s.logLevel("应用更新失败（当前程序未受影响）："+err.Error(), "err")
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	// spawn helper：等本进程退出 → 删 .old 备份 → 以原参数重启主程序。
	// helper 是**新版 exe 自己**（swap 后原路径已是新版），用户显式给的
	// 启动参数（--port / --console 等）原样透传，不会丢。
	originalArgs := os.Args[1:]
	if spawnErr := update.SpawnUpdateHelper(oldPath, originalArgs); spawnErr != nil {
		s.update.mu.Lock()
		s.update.running = false
		s.update.mu.Unlock()
		// swap 已完成但重启失败：旧版备份还在，给出可操作的恢复指引
		s.logLevel("替换完成，但自动重启失败："+spawnErr.Error(), "err")
		s.logf("请手动启动新版本；旧版备份在 " + oldPath + "（确认新版可用后可删除）")
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error":   "替换完成但自动重启失败：" + spawnErr.Error() + "。请手动启动新版本。",
			"swapped": true,
			"oldPath": oldPath,
		})
		return
	}

	s.logLevel("✓ 主程序已替换为新版本，正在重启…（浏览器稍后自动重连）", "ok")
	s.events.publish("update-done", map[string]any{
		"ok":    true,
		"file":  req.File,
		"note":  "已替换并重启，界面即将断开是正常现象",
		"apply": true,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "restarting": true})

	// 延迟退出：等响应送达浏览器
	go func() {
		time.Sleep(600 * time.Millisecond)
		_ = s.Stop()
		log.Printf("[cfpilot] 应用更新完成，进程退出（新版即将接管）")
		os.Exit(0)
	}()
}

// handleUpdateReveal 在文件管理器里打开下载目录。
//
// 自动替换失败（自动重启没成功等）时用户仍可能需要手动处理，
// 一键定位到文件是兜底能力。
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
