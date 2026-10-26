package server

// 本文件实现「部署类」API。
//
// ## 与 Electron 版的对应关系
//
//	window.cfpilot.runDeploy(params)     → POST /api/deploy/run
//	window.cfpilot.checkDeployed(kvId)   → POST /api/deploy/check
//	window.cfpilot.listKvOptions(accId)  → POST /api/kv/list
//	window.cfpilot.createKvNamespace(...) → POST /api/kv/create
//	window.cfpilot.detectAccount()       → POST /api/account/detect
//
// 部署是**长时间任务**（要建项目、配变量、等部署完成，可能 1~3 分钟），
// 所以接口设计成：
//   1. POST /api/deploy/run 立即返回 { started: true }
//   2. 进度通过 SSE 的 `log` 事件持续推送
//   3. 完成后推送 `deploy-status` 事件（含最终结果）
//
// 这样浏览器不会因为超时而中断，用户也能实时看到每一步。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// deployState 记录当前部署任务状态（同一时刻只允许一个部署）。
type deployState struct {
	mu      sync.Mutex
	running bool
}

// registerDeployRoutes 挂载部署相关路由。
func (s *Server) registerDeployRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/deploy/run", s.guard(s.handleDeployRun))
	mux.HandleFunc("/api/deploy/check", s.guard(s.handleDeployCheck))
	mux.HandleFunc("/api/account/detect", s.guard(s.handleAccountDetect))
	mux.HandleFunc("/api/kv/list", s.guard(s.handleKvList))
	mux.HandleFunc("/api/kv/create", s.guard(s.handleKvCreate))
}

// deployRequest 是部署请求体（字段与 Electron 版 runDeploy 的 params 对齐）。
type deployRequest struct {
	Mode  string `json:"mode"` // auto / fresh / update
	Force bool   `json:"force"`
	// ForceKv 对应界面的「强制覆盖 KV」
	ForceKv bool `json:"forceKv"`
	// NewCredentials 表示重新生成全部凭据（不沿用清单）
	NewCredentials bool `json:"newCredentials"`

	ControlProject string `json:"controlProject"`
	DataProject    string `json:"dataProject"`
	PanelPath      string `json:"panelPath"`
	WSPath         string `json:"wsPath"`

	// KVNamespaceID 可选，留空用当前账户里保存的
	KVNamespaceID string `json:"kvNamespaceId"`
}

// handleDeployRun 启动部署（异步）。
func (s *Server) handleDeployRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req deployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	// 取凭据
	profile, err := s.store.Active()
	if err != nil || profile == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "尚未保存 Cloudflare 凭据"})
		return
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少 API Token，请先在「账户配置」里填写"})
		return
	}
	if strings.TrimSpace(profile.AccountID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少账号 ID，请先点「自动检测账号」"})
		return
	}

	kvID := strings.TrimSpace(req.KVNamespaceID)
	if kvID == "" {
		kvID = strings.TrimSpace(profile.KVNamespaceID)
	}
	if kvID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "尚未选择 KV 命名空间，请到「Cloudflare 凭据」页刷新 KV 列表并选一个",
		})
		return
	}

	// 读内核产物
	controlScript, dataScript, build, err := s.loadKernelArtifacts()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	// 同一时刻只允许一个部署
	s.deploy.mu.Lock()
	if s.deploy.running {
		s.deploy.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "已有部署正在进行，请等待完成"})
		return
	}
	s.deploy.running = true
	s.deploy.mu.Unlock()

	mode := req.Mode
	if mode == "" || mode == "update" {
		mode = "auto"
	}

	opt := deploy.DefaultOptions()
	opt.Token = profile.CfToken
	opt.AccountID = profile.AccountID
	opt.KVNamespaceID = kvID
	opt.ControlScript = controlScript
	opt.DataScript = dataScript
	opt.Mode = mode
	opt.Force = req.ForceKv
	opt.ControlProject = req.ControlProject
	opt.DataProject = req.DataProject
	opt.PanelPath = req.PanelPath
	opt.WSPath = req.WSPath
	opt.LocalBuild = build
	// 「重新生成凭据」= 不沿用清单里的
	opt.KeepCredentials = !req.NewCredentials
	opt.SkipSameVersion = req.Mode != "update" // 显式更新时不跳过
	opt.Log = func(m string) { s.logf(m) }

	// 异步执行：接口立即返回，进度走 SSE
	go func() {
		defer func() {
			s.deploy.mu.Lock()
			s.deploy.running = false
			s.deploy.mu.Unlock()
		}()

		res, runErr := deploy.New(opt).Run(context.Background())

		payload := map[string]any{"ok": runErr == nil}
		if runErr != nil {
			payload["error"] = runErr.Error()
			s.logLevel("部署失败："+runErr.Error(), "err")
		} else {
			payload["result"] = res
			for _, warn := range res.Warnings {
				s.logLevel("⚠ "+warn, "warn")
			}
			if res.Skipped {
				s.logLevel("线上已是最新版本，跳过部署", "ok")
			} else {
				s.logLevel("部署完成", "ok")
			}
		}
		s.events.publish("deploy-status", payload)
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"started": true,
		"note":    "部署已开始，进度会通过 SSE 实时推送",
	})
}

// loadKernelArtifacts 读取内核产物（control.js / dataplane.js）。
//
// 产物随程序一起分发：Windows 是 exe 同目录的 worker-core/dist/，
// Linux 用同一个相对位置。也允许用环境变量覆盖（开发时直接指仓库）。
func (s *Server) loadKernelArtifacts() (control, data []byte, build string, err error) {
	dirs := []string{}
	if env := strings.TrimSpace(os.Getenv("CFPILOT_KERNEL_DIR")); env != "" {
		dirs = append(dirs, env)
	}
	// exe 同目录的 worker-core/dist
	if exe, e := os.Executable(); e == nil {
		base := filepath.Dir(exe)
		dirs = append(dirs,
			filepath.Join(base, "worker-core", "dist"),
			filepath.Join(base, "..", "worker-core", "dist"),
		)
	}
	// 开发期：从工作目录往上找
	if wd, e := os.Getwd(); e == nil {
		d := wd
		for i := 0; i < 5; i++ {
			dirs = append(dirs, filepath.Join(d, "packages", "worker-core", "dist"))
			d = filepath.Dir(d)
		}
	}

	for _, dir := range dirs {
		c, e1 := os.ReadFile(filepath.Join(dir, "control.js"))
		d, e2 := os.ReadFile(filepath.Join(dir, "dataplane.js"))
		if e1 == nil && e2 == nil && len(c) > 0 && len(d) > 0 {
			return c, d, readBuildVersion(dir, c), nil
		}
	}
	return nil, nil, "", fmt.Errorf(
		"找不到内核产物（control.js / dataplane.js）。\n" +
			"  请确认安装包里带 worker-core/dist，或用环境变量 CFPILOT_KERNEL_DIR 指定目录")
}

// readBuildVersion 从产物里提取版本串。
//
// 产物里的版本形如 `<git短hash>-<源码内容哈希前8位>`，例如 `a946dfa-1f2e3d4c`。
// 同时兼容纯数字（旧的 `202610251200` 格式）。
//
// ⚠️ 读不到就返回空串，**绝不返回 "unknown"** ——
// 假值会让「检查状态」显示「线上内核 unknown ≠ 本地 xxx」，用户看不懂。
func readBuildVersion(dir string, fallback []byte) string {
	// 优先读独立的版本文件（构建脚本会写）
	if raw, err := os.ReadFile(filepath.Join(dir, "build-version.txt")); err == nil {
		if v := strings.TrimSpace(string(raw)); v != "" {
			return v
		}
	}
	// 从产物里正则找（`const BUILD_VERSION = "xxx"` 之类）
	return extractBuildVersion(string(fallback))
}

// handleDeployCheck 检查线上部署状态。
//
// 返回 DeployStatus（与 Electron 版的 checkDeployed 对齐）：
//
//	{ state: 'none'|'outdated'|'latest'|'blocked',
//	  reason?: 'no-token'|'no-account'|'no-kv',
//	  localBuild, remoteBuild, controlProject, dataProject, ... }
func (s *Server) handleDeployCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		KVNamespaceID string `json:"kvNamespaceId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	profile, err := s.store.Active()
	if err != nil || profile == nil {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "reason": "no-token"})
		return
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "reason": "no-token"})
		return
	}
	if strings.TrimSpace(profile.AccountID) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "reason": "no-account"})
		return
	}
	kvID := strings.TrimSpace(req.KVNamespaceID)
	if kvID == "" {
		kvID = strings.TrimSpace(profile.KVNamespaceID)
	}
	if kvID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "reason": "no-kv"})
		return
	}

	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// 先读清单
	raw, ok := client.GetKVValue(ctx, profile.AccountID, kvID, deploy.ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none"})
		return
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "note": "部署清单格式损坏"})
		return
	}

	localBuild := ""
	if _, _, b, e := s.loadKernelArtifacts(); e == nil {
		localBuild = b
	}

	// 线上版本：优先读数据面的 /__version 端点（最权威）
	remoteBuild := m.Build
	if m.DataSubdomain != "" {
		if v := s.probeRemoteBuild(ctx, m.DataSubdomain); v != "" {
			remoteBuild = v
		}
	}

	state := "latest"
	switch {
	case remoteBuild == "" || localBuild == "":
		// 有一边读不到，无法判断新旧，按 outdated 处理让用户可选择更新
		state = "outdated"
	case remoteBuild != localBuild:
		state = "outdated"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"state":            state,
		"localBuild":       localBuild,
		"remoteBuild":      remoteBuild,
		"controlProject":   m.ControlProject,
		"dataProject":      m.DataProject,
		"controlSubdomain": m.ControlSubdomain,
		"dataSubdomain":    m.DataSubdomain,
		"customDomain":     m.DataCustomDomain,
		"deployedAt":       m.At,
	})
}

// handleAccountDetect 检测账号（用 Token 列出账号）。
func (s *Server) handleAccountDetect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		// Token 可选：不传就用已保存的（界面重新检测时不必重输）
		Token string `json:"token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	token := strings.TrimSpace(req.Token)
	if token == "" {
		p, err := s.store.Active()
		if err != nil || p == nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先填写 API Token"})
			return
		}
		token = p.CfToken
	}
	if token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先填写 API Token"})
		return
	}

	client := cfapi.New(cfapi.Options{Token: token})
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	accounts, err := client.ListAccounts(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "无法列出账号：" + err.Error(),
		})
		return
	}
	if len(accounts) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "这个 Token 下没有任何账号，请检查权限（需要 Account Settings: Read）",
		})
		return
	}

	// 只有一个账号时直接用；多个时返回列表让界面选
	if len(accounts) == 1 {
		acc := accounts[0]
		// 顺手把账号信息写回当前 profile
		if _, e := s.store.SaveActive(store.Patch{
			AccountID:   &acc.ID,
			AccountName: &acc.Name,
		}); e != nil {
			s.logLevel("保存账号信息失败："+e.Error(), "warn")
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"accountId":   acc.ID,
			"accountName": acc.Name,
			"accounts": []map[string]string{
				{"id": acc.ID, "name": acc.Name},
			},
		})
		return
	}

	list := make([]map[string]string, 0, len(accounts))
	for _, a := range accounts {
		list = append(list, map[string]string{"id": a.ID, "name": a.Name})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accountId":   "",
		"accountName": "",
		"accounts":    list,
	})
}

// handleKvList 列出 KV 命名空间并标注归属。
//
// 归属判定与部署侧的 inspectKvOwnership 保持一致：
//
//	instance  本工具部署的实例（含清单）
//	foreign   被 CFNext 占用 —— **界面应禁用**
//	cfpilot   含 CFPilot 配置但无清单（残留）
//	empty     空
func (s *Server) handleKvList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		AccountID string `json:"accountId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "尚未保存 API Token"})
		return
	}
	accountID := strings.TrimSpace(req.AccountID)
	if accountID == "" {
		accountID = profile.AccountID
	}
	if accountID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少账号 ID"})
		return
	}

	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	nsList, err := client.ListKVNamespaces(ctx, accountID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "列出 KV 失败：" + err.Error()})
		return
	}

	type kvOption struct {
		ID               string `json:"id"`
		Title            string `json:"title"`
		Ownership        string `json:"ownership"`
		ControlProject   string `json:"controlProject,omitempty"`
		DataProject      string `json:"dataProject,omitempty"`
		At               string `json:"at,omitempty"`
		Build            string `json:"build,omitempty"`
		ControlSubdomain string `json:"controlSubdomain,omitempty"`
		DataSubdomain    string `json:"dataSubdomain,omitempty"`
	}

	options := make([]kvOption, 0, len(nsList))
	for _, ns := range nsList {
		opt := kvOption{ID: ns.ID, Title: ns.Title, Ownership: "empty"}

		// 1) 有清单 → instance（或清单损坏 → cfpilot）
		if raw, ok := client.GetKVValue(ctx, accountID, ns.ID, deploy.ManifestKey); ok && strings.TrimSpace(raw) != "" {
			var m deploy.Manifest
			if err := json.Unmarshal([]byte(raw), &m); err == nil {
				opt.Ownership = "instance"
				opt.ControlProject = m.ControlProject
				opt.DataProject = m.DataProject
				opt.At = m.At
				opt.Build = m.Build
				opt.ControlSubdomain = m.ControlSubdomain
				opt.DataSubdomain = m.DataSubdomain
			} else {
				opt.Ownership = "cfpilot"
			}
			options = append(options, opt)
			continue
		}

		// 2) 没有清单：看有没有别的产品留下的痕迹
		if _, ok := client.GetKVValue(ctx, accountID, ns.ID, "config"); ok {
			opt.Ownership = "foreign"
		} else if _, ok := client.GetKVValue(ctx, accountID, ns.ID, deploy.ConfigKey); ok {
			opt.Ownership = "cfpilot"
		}
		options = append(options, opt)
	}

	instanceCount := 0
	for _, o := range options {
		if o.Ownership == "instance" {
			instanceCount++
		}
	}
	s.logf(fmt.Sprintf("找到 %d 个 KV 命名空间，其中 %d 个是 CFPilot 实例", len(options), instanceCount))

	writeJSON(w, http.StatusOK, map[string]any{
		"options":   options,
		"total":     len(options),
		"instances": instanceCount,
	})
}

// handleKvCreate 新建 KV 命名空间。
func (s *Server) handleKvCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		AccountID string `json:"accountId"`
		Title     string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "尚未保存 API Token"})
		return
	}
	accountID := strings.TrimSpace(req.AccountID)
	if accountID == "" {
		accountID = profile.AccountID
	}
	if accountID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少账号 ID"})
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "cfpilot-gui-" + shortRandom(8)
	}

	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	ns, err := client.CreateKVNamespace(ctx, accountID, title)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "创建 KV 失败：" + err.Error()})
		return
	}

	s.logLevel("已创建 KV 命名空间 "+ns.Title+"（"+ns.ID+"）", "ok")

	// 顺手写入当前账户，避免用户还要再选一次
	if _, e := s.store.SaveActive(store.Patch{KVNamespaceID: &ns.ID}); e != nil {
		s.logLevel("保存 KV 选择失败："+e.Error(), "warn")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":    ns.ID,
		"title": ns.Title,
	})
}

// shortRandom 生成短的随机后缀。
func shortRandom(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, n)
	now := time.Now().UnixNano()
	for i := range out {
		out[i] = alphabet[(now>>uint(i*3))%int64(len(alphabet))]
	}
	return string(out)
}

// errNoArtifacts 表示找不到内核产物。
var errNoArtifacts = errors.New("找不到内核产物")
