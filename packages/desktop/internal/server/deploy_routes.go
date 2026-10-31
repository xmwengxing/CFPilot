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
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/kernel"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/safe"
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
	mux.HandleFunc("/api/deploy/credentials", s.guard(s.handleDeployCredentials))
	mux.HandleFunc("/api/account/detect", s.guard(s.handleAccountDetect))
	mux.HandleFunc("/api/kv/list", s.guard(s.handleKvList))
	mux.HandleFunc("/api/kv/create", s.guard(s.handleKvCreate))
}

// newCFClient 建一个 Cloudflare 客户端。
//
// 统一走 s.cfBase：生产恒为空（官方地址），
// 测试可以指向 httptest 服务器来验证接口契约。
func (s *Server) newCFClient(token string) *cfapi.Client {
	return cfapi.New(cfapi.Options{Token: token, APIBase: s.cfBase})
}

// resolveKVNamespaceID 决定「本次用哪个 KV 命名空间」。
//
// 规则：**请求里指定的优先**，留空才回落到 profile 里保存的。
//
// ⚠️ 两个接口必须用同一套规则：
//
//	handleDeployCheck       读清单判断部署状态
//	handleDeployCredentials 读清单返回面板凭据
//
// 之前凭据接口压根不解析请求体，只用 profile 里的 KV：
// 下拉框选中的 KV 与 profile 保存的不一致时，
// 返回的是**另一个 KV** 的面板密码 / UUID / WS 路径
// → 用户拿错密码去登别的实例。
func resolveKVNamespaceID(requested, profileKV string) string {
	if v := strings.TrimSpace(requested); v != "" {
		return v
	}
	return strings.TrimSpace(profileKV)
}

// deploySkipSameVersion 判断本次部署是否跳过「线上版本与本地相同」的部署。
//
// 规则：
//   - mode == "update" → 不跳过（用户显式点了「更新部署」）
//   - force（界面的「强制重新部署」）→ 不跳过
//   - 其余 → 跳过（避免无谓触发平台审核）
//
// ⚠️ 之前 force 是**死字段**：界面传了，后端一次都没用，
// 于是勾了「强制重新部署」但线上版本相同时照样跳过 → 复选框完全无效。
// CLI 的 --force 是生效的（skipSameVersion = !flagBool(args,'force')），
// 两端必须一致（AGENTS.md §1.3）。
func deploySkipSameVersion(mode string, force bool) bool {
	return mode != "update" && !force
}

// deployRequest 是部署请求体（字段与 Electron 版 runDeploy 的 params 对齐）。
type deployRequest struct {
	Mode string `json:"mode"` // auto / fresh / update
	// Force 对应界面的「强制重新部署（忽略版本相同则跳过）」。
	//
	// ⚠️ 与 ForceKv 语义不同，两个都要看：
	//   - Force   → 忽略「线上版本 == 本地版本」这一跳过条件
	//   - ForceKv → 强制越过 KV 归属校验（接管另一个实例占用的 KV）
	Force bool `json:"force"`
	// ForceKv 对应界面的「强制覆盖 KV」
	ForceKv bool `json:"forceKv"`
	// NewCredentials 表示重新生成全部凭据（不沿用清单）
	NewCredentials bool `json:"newCredentials"`

	ControlProject string `json:"controlProject"`
	DataProject    string `json:"dataProject"`
	PanelPath      string `json:"panelPath"`
	WSPath         string `json:"wsPath"`

	// DataHost 是 Workers 数据面的节点域名（写进控制面 DATA_HOST，工具不绑定）
	DataHost string `json:"dataHost"`
	// DataPlaneMode 是数据面部署形态：pages / workers。
	//
	// 留空 = 沿用部署清单里记录的形态（没有清单则 pages）。
	// 界面**总是**发送当前选中的值，并在读取部署状态时把清单里的形态回填到
	// 单选框 —— 否则「一个 Workers 实例被顺手更新一次」就会被悄悄改成 Pages。
	DataPlaneMode string `json:"dataPlaneMode"`

	// KVNamespaceID 可选，留空用当前账户里保存的
	KVNamespaceID string `json:"kvNamespaceId"`

	// PanelPassword 是**本次部署**要设置的面板密码（可选）。
	//
	// 留空表示随机生成（首次）或沿用清单原密码（更新）。
	// ⚠️ 与账户里的 PanelPassword（用于改已部署面板的密码）严格分开。
	PanelPassword string `json:"panelPassword"`
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
	//
	// ⚠️ 用 LoadPreferred 而不是 Load：远程若有**更新的内核**，
	// 就用远程的部署（应用版本不再绑死部署用的代码）。
	loadCtx, cancelLoad := context.WithTimeout(context.Background(), 90*time.Second)
	artifacts, err := s.loadKernelArtifacts(loadCtx)
	cancelLoad()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	controlScript := artifacts.Control
	dataScript := artifacts.Data
	build := artifacts.Build
	kernelVersion := artifacts.Version

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
	// 数据面形态：只接受 pages / workers，其它值当作「沿用清单」
	plane := strings.ToLower(strings.TrimSpace(req.DataPlaneMode))
	if plane == "pages" || plane == "workers" {
		opt.DataPlaneMode = plane
	}
	if opt.DataPlaneMode == "workers" {
		opt.DataHost = strings.TrimSpace(req.DataHost)
	}
	opt.Force = req.ForceKv
	opt.ControlProject = req.ControlProject
	opt.DataProject = req.DataProject
	opt.PanelPath = req.PanelPath
	opt.WSPath = req.WSPath
	// ⚠️ 部署密码只读 DeployPanelPassword，**绝不读 PanelPassword**
	//
	//
	// 历史教训：
	//   早期两个输入框都写同一个 PanelPassword 字段 ——
	//     凭据页「修改已部署面板的密码」→ saveCredentials({panelPassword})
	//     部署时                        → opt.PanelPassword = profile.PanelPassword
	//   结果在凭据页改了密码，下次部署的密码也跟着变，
	//   而云端环境变量加密，用户完全不知道自己改了部署密码，
	//   于是面板登不进去（真机踩过）。
	//
	// 现在语义清晰：
	//   - DeployPanelPassword：部署页填的，只在部署时用
	//   - PanelPassword：凭据页填的，只用于「登录已部署面板去改密码」
	//   - 都没填 → 首次部署随机生成 / 更新部署沿用清单原密码
	if v := strings.TrimSpace(req.PanelPassword); v != "" {
		opt.PanelPassword = v
	} else {
		opt.PanelPassword = strings.TrimSpace(profile.DeployPanelPassword)
	}
	opt.LocalBuild = build
	opt.LocalKernelVersion = kernelVersion
	// 「重新生成凭据」= 不沿用清单里的
	opt.KeepCredentials = !req.NewCredentials
	// ⚠️ 「强制重新部署」= 忽略「版本相同则跳过」。
	//
	// req.Force 之前是死字段（声明了但一次都没用），
	// 界面上勾了「强制重新部署」但线上版本相同时照样跳过 → 复选框完全无效。
	// CLI 的 --force 是生效的（skipSameVersion = !flagBool(args,'force')），
	// 两端必须一致。
	//
	// ⚠️ 与 opt.Force（= req.ForceKv）语义不同，别混：
	//   - ForceKv：强制越过 KV 归属校验（另一个实例占用时接管）
	//   - Force  ：强制重新部署（哪怕线上版本与本地相同）
	opt.SkipSameVersion = deploySkipSameVersion(req.Mode, req.Force)
	opt.Log = func(m string) { s.logf(m) }

	// 异步执行：接口立即返回，进度走 SSE
	go func() {
		defer func() {
			s.deploy.mu.Lock()
			s.deploy.running = false
			s.deploy.mu.Unlock()
		}()

		// ⚠️ **panic 兜底**：部署跑在后台 goroutine 里，
		// panic 会让**整个进程**退出（托盘 + 服务 + 日志一起消失），
		// 而 panic 信息在托盘模式的 stderr 里用户看不见。
		//
		// 接住 → 记日志（含堆栈）→ 报给界面，进程继续跑。
		defer func() {
			if r := safe.Recover("部署任务"); r != nil {
				s.logLevel("部署过程发生内部错误，详情已记入日志（服务继续运行）", "err")
				s.events.publish("deploy-status", map[string]any{
					"ok":    false,
					"error": "部署过程发生内部错误，详情已记入日志",
				})
			}
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

			// ⚠️ 必须把面板凭据完整打印出来
			//
			// 早期 Go 版**完全没有这段汇总**，导致：
			//   - 部署成功后界面看不到面板密码 / 路径
			//   - 云端环境变量是加密的，用户也读不到
			//   - 结果：面板进不去（密码丢了就彻底没了）
			//
			// Electron 版一直有这段汇总，Go 版漏了。
			// 注意：**只在面板密码不是从清单沿用来的全新值时**才值得强调，
			// 但无论新旧都要显示 —— 用户可能忘了。
			if !res.Skipped {
				s.logSummary(res)
			}
		}
		s.events.publish("deploy-status", payload)
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"started": true,
		"note":    "部署已开始，进度会通过 SSE 实时推送",
	})
}

// loadKernelArtifacts 读取「应该用于部署」的内核产物（control.js / dataplane.js）。
//
// 实际实现在 internal/kernel 包里 —— 那边用 go:embed 把产物**内嵌进 exe**，
// 同时支持从 GitHub Release 拉取**更新的内核**（见 kernel.LoadPreferred）。
//
// ## 为什么改成内嵌
//
// 最初的设计假设「exe 旁边有 worker-core/dist 目录」，但构建脚本
// 从来没把产物拷进去。用户下载的单文件 exe 完全不包含内核，
// 点「开始部署」直接报「找不到内核产物」—— 部署功能 100% 不可用。
//
// 现在产物编译进二进制，真正的单文件分发。
//
// ## 为什么还要远程内核
//
// 内嵌意味着「部署用的代码被应用版本绑死」—— 用户没升级应用就
// 只能部署旧内核。远程内核把两者解耦：应用不升级也能部署新内核。
//
// ⚠️ 远程不可用（离线）时**自动回退到内嵌产物**，绝不让部署失败。
func (s *Server) loadKernelArtifacts(ctx context.Context) (*kernel.Artifacts, error) {
	a, info, err := kernel.LoadPreferred(ctx, Version())
	if err != nil && a == nil {
		return nil, fmt.Errorf(
			"内核产物不可用：%w\n"+
				"  这通常意味着构建时漏了拷贝内核产物。\n"+
				"  请重新执行 node scripts/build-desktop.mjs（它会自动拷贝）", err)
	}
	if err != nil {
		// 降级（远程下载失败之类）：给出警告，但继续用可用的内核部署
		s.logLevel("⚠ "+err.Error(), "warn")
	}
	if a == nil {
		return nil, fmt.Errorf("内核产物不可用")
	}
	log.Printf("[cfpilot] 内核产物已加载（%s，control=%dKB data=%dKB，build=%s，内核版本=%s）",
		a.Source, len(a.Control)/1024, len(a.Data)/1024, a.Build, a.Version)
	if info != nil && info.Version != a.Version {
		log.Printf("[cfpilot] 远程可用内核版本：%s（本次未采用）", info.Version)
	}
	return a, nil
}

// localKernelBuild 返回本地内核的构建指纹（不联网）。
//
// 「检查状态」只需要 build 指纹做「线上 ≠ 本地」的判断，
// 不该为了拿指纹去连 GitHub。
func localKernelBuild() string {
	a, err := kernel.Load()
	if err != nil {
		return ""
	}
	return a.Build
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
//
// 另外还返回**内核版本对比**（build 指纹比不出新旧，semver 可以）：
//
//	{ kernelVersion:       线上已部署的内核版本（清单里的；旧清单为空 = 未知）
//	  localKernelVersion:  应用内嵌的内核版本（= 应用版本）
//	  remoteKernelVersion: 远程最新的内核版本（查不到就是空串）
//	  kernelUpdatable:     远程是否比线上新
//	  kernelRemoteError:   远程查询失败的原因（没有失败就是空串） }
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
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "hasDeploy": false, "reason": "no-token"})
		return
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "hasDeploy": false, "reason": "no-token"})
		return
	}
	if strings.TrimSpace(profile.AccountID) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "hasDeploy": false, "reason": "no-account"})
		return
	}
	kvID := resolveKVNamespaceID(req.KVNamespaceID, profile.KVNamespaceID)
	if kvID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "hasDeploy": false, "reason": "no-kv"})
		return
	}

	client := s.newCFClient(profile.CfToken)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// 先读清单
	raw, ok := client.GetKVValue(ctx, profile.AccountID, kvID, deploy.ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "hasDeploy": false})
		return
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"state": "none", "hasDeploy": false, "note": "部署清单格式损坏"})
		return
	}

	localBuild := localKernelBuild()

	// 线上版本：优先问数据面自己（最权威），探不到才回落清单里的值。
	//
	// ⚠️ 用 `rv.Build`（构建指纹）比对，**不能**用 `rv.Version`（语义版本）：
	// 两者含义不同，混用会让「线上与本地是否同一份产物」永远判为不同。
	// 见 version_probe.go 的 remoteVersion 注释。
	remoteBuild := m.Build
	liveKernel := ""
	if m.DataSubdomain != "" {
		if rv := s.probeRemoteVersion(ctx, m.DataSubdomain); rv.Build != "" || rv.Version != "" {
			if rv.Build != "" {
				remoteBuild = rv.Build
			}
			liveKernel = rv.Version
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

	// ---------------- 内核版本对比 ----------------
	//
	// ⚠️ 远程查询**必须能失败**（离线时不能让整个检查状态失败）。
	// 查不到就返回空串 + kernelUpdatable=false，并给出说明字段。
	ks := kernelStatus{Deployed: strings.TrimSpace(m.KernelVersion), Local: Version()}
	// 线上自报的语义版本比清单可靠（清单是部署时写死的，用户可能在控制台
	// 手工重新部署过）。有就用它；没有才退回清单值。
	//
	// 这就是「Workers 实例没有内核版本」的直接修法：不再只依赖清单。
	if liveKernel != "" && liveKernel != "dev" {
		ks.Deployed = liveKernel
	}
	remoteCtx, cancelRemote := context.WithTimeout(ctx, 8*time.Second)
	if info, e := kernel.FetchRemoteInfo(remoteCtx); e != nil {
		ks.RemoteErr = e.Error()
		s.logLevel("⚠ 查询远程内核版本失败："+e.Error(), "warn")
	} else if info != nil {
		ks.Remote = info.Version
	}
	cancelRemote()

	writeJSON(w, http.StatusOK, buildDeployStatusResponse(&m, state, localBuild, remoteBuild, ks))
}

// kernelStatus 是内核版本的对比结果。
type kernelStatus struct {
	// Deployed 是线上已部署的内核版本（清单里的；旧清单为空 = 版本未知）
	Deployed string
	// Local 是应用内嵌的内核版本（= 应用版本）
	Local string
	// Remote 是远程最新的内核版本（查不到就是空串）
	Remote string
	// RemoteErr 是远程查询失败的原因（没有失败就是空串）
	RemoteErr string
}

// Updatable 判断远程内核是否比线上更新。
//
// ⚠️ 线上版本未知（空串）时，CompareSemver 把空串当成「更旧」，
// 于是结果为 true —— 这是**故意的**：
// 线上版本都读不出来，用户更应该重新部署一次拿到确定的版本。
//
// 远程版本查不到（离线）时永远是 false —— 不能凭「查不到」就催用户更新。
func (k kernelStatus) Updatable() bool {
	if strings.TrimSpace(k.Remote) == "" {
		return false
	}
	return kernel.CompareSemver(k.Remote, strings.TrimSpace(k.Deployed)) > 0
}

// buildDeployStatusResponse 组装「检查状态」的响应体。
//
// 抽成纯函数是为了能直接测字段契约（界面读的就是这些字段名）。
// dataPlaneModeOf 归一化清单里的数据面形态。
//
// 旧清单没有这个字段（历史版本只有 Pages 形态），一律按 pages 处理 ——
// 不能返回空串，否则界面单选框会「一个都不选中」。
func dataPlaneModeOf(m *deploy.Manifest) string {
	if m != nil && m.DataPlaneMode == "workers" {
		return "workers"
	}
	return "pages"
}

func buildDeployStatusResponse(
	m *deploy.Manifest,
	state, localBuild, remoteBuild string,
	ks kernelStatus,
) map[string]any {
	return map[string]any{
		// ⚠️ 字段名必须与 Electron 版 DeployStatus **逐字段一致**
		//
		//
		// 界面代码（renderer.ts 的 applyDeployStatus）读的是：
		//   status.build        ← 线上内核版本
		//   status.localBuild   ← 本地内核版本
		//   status.at           ← 部署时间
		//
		// 我最初返回 remoteBuild / deployedAt，于是：
		//   - status.build 是 undefined → `if (!status.build)` 恒为真
		//     → 永远走「读不到版本」分支，界面看起来毫无变化
		//   - status.at 是 undefined → 不显示部署时间
		//
		// 这就是用户看到的「永远是空壳按钮、只打一句日志」。
		"state":            state,
		"hasDeploy":        true,
		"build":            remoteBuild, // 契约字段名（线上版本）
		"localBuild":       localBuild,
		"at":               m.At, // 契约字段名（部署时间）
		"controlProject":   m.ControlProject,
		"dataProject":      m.DataProject,
		"controlSubdomain": m.ControlSubdomain,
		"dataSubdomain":    m.DataSubdomain,
		"customDomain":     m.DataCustomDomain,
		// 数据面形态：界面用它把「Pages / Workers」单选框回填成线上实际形态。
		// 旧清单没有这个字段 → 按 pages 处理（旧版本只有 Pages 形态）。
		"dataPlaneMode": dataPlaneModeOf(m),

		// ---- 内核版本对比（新增）----
		//
		// kernelVersion         线上已部署的内核版本（清单里的，旧清单为空 = 未知）
		// localKernelVersion    应用内嵌的内核版本（= 应用版本）
		// remoteKernelVersion   远程最新的内核版本（查不到就是空串）
		// kernelUpdatable       远程是否比线上新
		// kernelRemoteError     远程查询失败的原因（没有失败就是空串）
		"kernelVersion":       ks.Deployed,
		"localKernelVersion":  ks.Local,
		"remoteKernelVersion": ks.Remote,
		"kernelUpdatable":     ks.Updatable(),
		"kernelRemoteError":   ks.RemoteErr,
	}
}

// handleDeployCredentials 返回清单里保存的面板凭据（供界面随时查看）。
//
// ## 为什么需要这个接口
//
// Cloudflare 平台上的环境变量是**加密的**（页面只显示 `****`），
// 所以一旦部署完成时没记下面板密码，用户就彻底拿不回来了。
//
// 部署清单（KV 里的 CFP_DEPLOY_MANIFEST）里保存了明文凭据，
// 这个接口把它读出来给界面展示。数据只在本机回环服务内流转。
//
// ⚠️ 安全：接口仍需会话 Cookie；不对外网暴露。
func (s *Server) handleDeployCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	// ⚠️ 必须解请求体里的 kvNamespaceId —— 界面传的正是「当前选中的 KV」。
	//
	// 之前这里连请求体都没解，只用 profile 里保存的 KV：
	// 下拉框选中的 KV 与 profile 保存的不一致时，
	// 返回的是**另一个 KV** 的面板密码 / UUID / WS 路径
	// → 用户拿错密码去登别的实例。
	//
	// 与 handleDeployCheck 保持一致：请求优先，留空才用 profile 的。
	var req struct {
		KVNamespaceID string `json:"kvNamespaceId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先保存 API Token"})
		return
	}
	kvID := resolveKVNamespaceID(req.KVNamespaceID, profile.KVNamespaceID)
	if kvID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先选择 KV 命名空间"})
		return
	}

	client := s.newCFClient(profile.CfToken)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	raw, ok := client.GetKVValue(ctx, profile.AccountID, kvID, deploy.ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "这个 KV 里没有部署记录，请先完成一次部署",
		})
		return
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "部署清单格式损坏"})
		return
	}

	// 面板完整地址 = 控制面域名 + 面板路径
	// ⚠️ 面板路径必须保证带前导斜杠（兼容清单里可能存在的旧格式裸串）
	panelPath := m.Credentials.PanelPath
	if panelPath != "" && !strings.HasPrefix(panelPath, "/") {
		panelPath = "/" + panelPath
	}
	panelURL := ""
	if m.ControlSubdomain != "" && panelPath != "" {
		host := m.ControlSubdomain
		if !strings.HasPrefix(host, "http") {
			host = "https://" + host
		}
		panelURL = host + panelPath
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"panelUrl":      panelURL,
		"panelPath":     panelPath,
		"panelPassword": m.Credentials.PanelPassword,
		"uuid":          m.Credentials.UUID,
		"wsPath":        m.Credentials.WSPath,
		"dataSubdomain": m.DataSubdomain,
		"build":         m.Build,
		"at":            m.At,
	})
}

// logSummary 打印部署完成后的凭据汇总。
//
// ## 为什么必须有
//
// 用户部署成功后**看不到面板密码**，而 Cloudflare 平台上的环境变量
// 是加密的（页面只显示 `****`），所以密码一旦没记录就彻底找不回来，
// 面板永远进不去。
//
// Electron 版一直有这个汇总块，Go 版漏了 —— 属于功能缺失。
//
// 输出内容（与 Electron 版对齐）：
//   - 控制面 / 数据面的访问地址
//   - UUID、WS 路径
//   - **面板路径与面板密码**（最关键）
func (s *Server) logSummary(res *deploy.Result) {
	line := strings.Repeat("─", 52)

	s.logLevel(line, "info")
	s.logLevel("部署完成，以下是访问本实例所需的全部信息", "ok")
	s.logLevel(line, "info")

	if res.Control.Subdomain != "" {
		s.logLevel("控制面地址："+res.Control.Subdomain, "info")
	}
	if res.Data.Subdomain != "" {
		s.logLevel("订阅域名："+res.Data.Subdomain, "info")
	}

	if res.UUID != "" {
		s.logLevel("UUID："+res.UUID, "info")
	}
	if res.WSPath != "" {
		s.logLevel("WS 路径："+res.WSPath, "info")
	}

	// ⚠️ 面板凭据单独强调 —— 这是用户唯一一次能看到明文密码的机会
	if res.PanelPath != "" {
		s.logLevel("面板路径："+res.PanelPath, "ok")
	}
	if res.PanelPassword != "" {
		s.logLevel("面板密码："+res.PanelPassword, "ok")
		s.logLevel("⚠ 请立刻保存面板密码 —— 云端环境变量是加密的，之后无法再读取", "warn")
	}

	if res.Control.Subdomain != "" && res.PanelPath != "" {
		s.logLevel("面板完整地址：https://"+res.Control.Subdomain+res.PanelPath, "ok")
	}

	s.logLevel(line, "info")
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

	// usingProfileToken 表示「本次探测用的是当前 profile 自己的 Token」。
	//
	// ⚠️ 只有这种情况下才能把探测结果写回 profile。
	//
	// 调用方显式传了外部 Token（req.Token != ""）时，探测出来的账号
	// 属于**那个外部 Token**，而当前 profile 的 CfToken 并不会更新 ——
	// 写回 AccountID 会让 profile 变成「token A + accountId B」的混合体：
	// 之后拿 token A 去列 account B 的 KV → 403 / 空列表。
	// 所以外部 Token 只回显探测结果，**绝不落盘**。
	token := strings.TrimSpace(req.Token)
	usingProfileToken := token == ""
	if usingProfileToken {
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

	client := s.newCFClient(token)
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
		//
		// ⚠️ 仅限「用的是当前 profile 自己的 Token」：
		// 外部 Token 探测出来的账号不属于本 profile，
		// 写回去会造成「token A + accountId B」的混合体（见上面的说明）。
		if usingProfileToken {
			if _, e := s.store.SaveActive(store.Patch{
				AccountID:   &acc.ID,
				AccountName: &acc.Name,
			}); e != nil {
				s.logLevel("保存账号信息失败："+e.Error(), "warn")
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"accountId":   acc.ID,
			"accountName": acc.Name,
			"accounts": []map[string]string{
				{"id": acc.ID, "name": acc.Name},
			},
			// saved=false 表示「只回显、没落盘」（外部 Token 探测）。
			"saved": usingProfileToken,
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
		"saved":       usingProfileToken,
	})
}

// handleKvList 列出 KV 命名空间并标注归属。
//
// 归属判定与部署侧的 inspectKvOwnership 保持一致：
//
//	instance  本工具部署的实例（含清单）
//	foreign   被旧版第三方实现占用 —— **界面应禁用**
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

	// 走 newCFClient（而不是直接 cfapi.New）：测试可注入假 API 根地址
	client := s.newCFClient(profile.CfToken)
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

	// ---- 逐个命名空间读清单，但**并发** ----
	//
	// 每个命名空间都要读 1~3 个键，每次都是一趟 Cloudflare API。
	// 串行时 6 个命名空间实测要 20~25 秒（跨境链路 RTT 大），
	// 而凭据页启动时就会触发这个请求 —— 用户看到的是「检测账号…」卡住二十多秒，
	// 很像程序假死。
	//
	// 并发 4 路（不无限放大：CF 免费版有速率限制）：实测降到 5~8 秒，
	// 且顺序不变（结果按下标写回，前端下拉框顺序稳定）。
	const kvProbeConcurrency = 4
	options := make([]kvOption, len(nsList))
	for i, ns := range nsList {
		options[i] = kvOption{ID: ns.ID, Title: ns.Title, Ownership: "empty"}
	}

	sem := make(chan struct{}, kvProbeConcurrency)
	var wg sync.WaitGroup
	for i := range nsList {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ns := nsList[i]
			opt := &options[i]

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
				return
			}

			// 2) 没有清单：看有没有别的产品留下的痕迹
			if _, ok := client.GetKVValue(ctx, accountID, ns.ID, "config"); ok {
				opt.Ownership = "foreign"
			} else if _, ok := client.GetKVValue(ctx, accountID, ns.ID, deploy.ConfigKey); ok {
				opt.Ownership = "cfpilot"
			}
		}(i)
	}
	wg.Wait()

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

	client := s.newCFClient(profile.CfToken)
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
