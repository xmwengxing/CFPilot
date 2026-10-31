// Package deploy 实现 Pages 双项目部署。
//
// ## 端口来源
//
// 对应 packages/deploy-wizard/src/pages-deploy.ts（约 1100 行 TS）。
// 这里的每一条规则都是真机踩出来的，**改动前必须先读 TS 版的注释**，
// 否则会重新踩同一个坑。
//
// ## 必须守住的五条
//
//  1. **写入任何 KV 键之前先校验归属**（assertKvOwnership）。
//     越界写入会改坏别人的线上项目：订阅指向错误 UUID、面板路径被覆盖、
//     会话可跨实例复用，事后极难清理。判断归属**只能靠清单键
//     CFP_DEPLOY_MANIFEST** —— 标题、UUID、路径都不唯一。
//
//  2. **顺序必须是「建项目 → 设变量/绑 KV → 部署」**。
//     Pages 的绑定与变量只对**之后的**部署生效；先部署再配置等于白配。
//     且 PATCH 会自动触发一次部署，之后再 POST /deployments 就是二次部署 →
//     触发 8000119。
//
//  3. **先部署数据面，再部署控制面**。控制面的 DATA_HOST 要填数据面域名。
//     且数据面因 8000119 换名后**必须重配控制面的 DATA_HOST**，
//     否则订阅里的 sni/host 全指向已删除的旧域名，所有节点失效。
//
//  4. **写 KV 的是大写 `CONFIG` 键，绝不是小写 `config`**。
//     小写键是旧版第三方实现的，往里写会整体覆盖共栖项目的配置。
//
//  5. **清单里的 build 读不到就写空串，绝不写 "unknown"**。
//     假值会让「检查状态」显示「线上内核 unknown ≠ 本地 xxx」，用户看不懂。
package deploy

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// 常量：KV 里用到的键名。
const (
	// ManifestKey 是部署清单键，判断 KV 归属**只能**靠它。
	ManifestKey = "CFP_DEPLOY_MANIFEST"
	// ConfigKey 是内核配置键（大写！小写 config 是旧版第三方实现的，绝不能写）。
	ConfigKey = "CONFIG"
)

// Options 是部署参数。
type Options struct {
	// ---- 必填 ----
	Token         string
	AccountID     string
	KVNamespaceID string

	// ---- 产物 ----
	// ControlScript 是控制面 _worker.js 内容
	ControlScript []byte
	// DataScript 是数据面 _worker.js 内容
	DataScript []byte

	// ---- 模式 ----
	// Mode: "auto"（有清单就更新）/ "fresh"（强制首次）
	Mode string
	// DataPlaneMode 是数据面部署形态："pages"（默认）/ "workers"。
	//
	// 空串 = **沿用清单里记录的形态**（没有清单则 pages）。
	// 与「显式传 pages」不同：后者对 Workers 实例来说是一次形态切换。
	DataPlaneMode string
	// DataHost 是 Workers 数据面的自定义域名（只对 workers 生效）。
	//
	// 留空时优先沿用清单里记录的旧域名，都没有才回落到 *.workers.dev（并告警）。
	DataHost string
	// KeepCredentials 更新时沿用清单里的 UUID / WS 路径（默认 true）
	KeepCredentials bool
	// SkipSameVersion 本地版本与线上一致时跳过部署（默认 true）
	SkipSameVersion bool
	// Force 忽略归属校验（危险，仅用户显式确认时用）
	Force bool

	// ---- 可选覆盖（留空则自动生成或沿用清单）----
	ControlProject string
	DataProject    string
	PanelPath      string
	PanelPassword  string
	UUID           string
	TrojanPassword string
	WSPath         string
	ScannerToken   string

	// ---- 功能开关 ----
	//
	// ⚠️ 默认值必须与 CLI 一致（AGENTS.md §2.2：CLI 是部署语义的权威实现）。
	//
	// CLI 的 deploy/command.ts 固定传 enableTrojan: true / enableXhttp: true，
	// 并据此写 KV 的 CONFIG 与 Pages 的 ENABLE_TROJAN / ENABLE_XHTTP 环境变量。
	// Go 侧之前用零值 false，而 HTTP 层从不设置这两个字段
	// → GUI 部署出来的实例 Trojan 被强制关闭，与 CLI 部署出来的不一致。
	//
	// 要覆盖时由调用方显式赋值（DefaultOptions 之后再改）。
	EnableTrojan bool
	EnableXHTTP  bool
	// ResolvePreferred 用 nil 表示「不注入」，true/false 表示显式指定
	ResolvePreferred *bool

	// ---- 版本号（用于同版本跳过与写清单）----
	// LocalBuild 是**构建指纹**（`<hash>-<hash>`），精确但没有大小顺序
	LocalBuild string
	// LocalKernelVersion 是**本次要部署的内核的语义化版本**（如 "0.7.6"）。
	//
	// 与 LocalBuild 的分工：
	//   - LocalBuild  → 写进清单的 build 字段，用于判断「是不是同一份产物」
	//   - LocalKernelVersion → 写进清单的 kernelVersion 字段，用于判断「谁更新」
	//
	// 远程内核的版本号就是 Release 的版本号；内嵌内核的是应用版本。
	LocalKernelVersion string

	// ---- 高级 ----
	// APIBase 覆盖 Cloudflare API 地址（测试用，生产留空）
	APIBase string

	// ---- 回调 ----
	Log func(string)

	// ---- 等待部署完成 ----
	WaitTimeout  time.Duration
	WaitInterval time.Duration
}

// Result 是部署结果。
type Result struct {
	Control  Slot     `json:"control"`
	Data     Slot     `json:"data"`
	Warnings []string `json:"warnings"`

	// 生效的凭据（界面需要展示给用户）
	PanelPath     string `json:"panelPath"`
	PanelPassword string `json:"panelPassword"`
	UUID          string `json:"uuid"`
	WSPath        string `json:"wsPath"`

	// Skipped 为 true 表示因同版本而跳过
	Skipped bool `json:"skipped"`

	// DataPlaneMode 是本次生效的数据面形态（pages / workers）
	DataPlaneMode string `json:"dataPlaneMode"`
}

// Slot 是一个项目的部署状态。
type Slot struct {
	Name         string `json:"name"`
	Subdomain    string `json:"subdomain"`
	DeploymentID string `json:"deploymentId"`
}

// Manifest 是部署清单（存在 KV 里）。
type Manifest struct {
	V                int    `json:"v"`
	KVNamespaceID    string `json:"kvNamespaceId"`
	ControlProject   string `json:"controlProject"`
	DataProject      string `json:"dataProject"`
	ControlSubdomain string `json:"controlSubdomain"`
	DataSubdomain    string `json:"dataSubdomain"`
	DataCustomDomain string `json:"dataCustomDomain"`
	// DataPlaneMode 是数据面部署形态；旧清单没有这个字段 = "pages"。
	//
	// 记它是为了更新时识别「用户是否改过形态」—— 改过就要在新数据面上线后
	// 删掉旧的，否则账号里同时留着一个 Pages 项目和一个 Worker。
	DataPlaneMode string `json:"dataPlaneMode,omitempty"`
	// Build 是内核**构建指纹**（`<hash>-<hash>`），读不到为空串
	Build string `json:"build"`
	// KernelVersion 是内核**语义化版本**（如 "0.7.6"）。
	//
	// ⚠️ 旧清单没有这个字段 → 读出来是空串 → 视为「版本未知」。
	// 空串**绝不**写成 "unknown"（假值会让用户看不懂）。
	KernelVersion string      `json:"kernelVersion"`
	At            string      `json:"at"`
	Credentials   Credentials `json:"credentials"`
}

// Credentials 是清单里保存的凭据。
type Credentials struct {
	PanelPath      string `json:"panelPath"`
	PanelPassword  string `json:"panelPassword"`
	UUID           string `json:"uuid"`
	TrojanPassword string `json:"trojanPassword"`
	WSPath         string `json:"wsPath"`
}

// effective 是本次生效的凭据。
type effective struct {
	panelPath      string
	panelPassword  string
	uuid           string
	trojanPassword string
	wsPath         string
}

// Deployer 是部署执行器。
type Deployer struct {
	client *cfapi.Client
	opt    Options
	// result 持续累积（换名重试时也要写进去）
	result Result
}

// New 创建部署器。
func New(opt Options) *Deployer {
	if opt.Mode == "" {
		opt.Mode = "auto"
	}
	if opt.WaitTimeout == 0 {
		opt.WaitTimeout = 90 * time.Second
	}
	if opt.WaitInterval == 0 {
		opt.WaitInterval = 3 * time.Second
	}
	if opt.Log == nil {
		opt.Log = func(string) {}
	}
	// KeepCredentials / SkipSameVersion 默认 true。
	// 用指针才能区分「没传」与「显式 false」，这里由调用方保证默认值，
	// 见 DefaultOptions()。
	return &Deployer{
		client: cfapi.New(cfapi.Options{Token: opt.Token, APIBase: opt.APIBase}),
		opt:    opt,
		result: Result{Warnings: []string{}},
	}
}

// DefaultOptions 返回带默认值的 Options（调用方在此基础上填必填项）。
func DefaultOptions() Options {
	return Options{
		Mode:            "auto",
		KeepCredentials: true,
		SkipSameVersion: true,
		WaitTimeout:     90 * time.Second,
		WaitInterval:    3 * time.Second,
		Log:             func(string) {},
		// 与 CLI 对齐（packages/cli/src/deploy/command.ts）：
		// enableTrojan: true / enableXhttp: true。
		// XHTTP 自 2026-10-28 起默认开启：数据面上它只是多一条需要合法 VLESS 头的
		// POST 路由，用户想关在面板「入站配置」里关即可（面板写 KV，优先级高于环境变量）。
		//
		// ⚠️ 之前这里是 Go 零值 false —— Trojan 被强制关闭，
		// GUI 部署出来的实例与 CLI 部署出来的行为不一致。
		EnableTrojan: true,
		EnableXHTTP:  true,
	}
}

func (d *Deployer) log(msg string) { d.opt.Log(msg) }

func (d *Deployer) warn(msg string) { d.result.Warnings = append(d.result.Warnings, msg) }

// Run 执行部署。
func (d *Deployer) Run(ctx context.Context) (*Result, error) {
	if err := d.validate(); err != nil {
		return nil, err
	}

	// ---------------- 0. 读清单，判断首次还是更新 ----------------
	manifest, err := d.readManifest(ctx)
	if err != nil {
		return nil, err
	}

	eff := effective{
		panelPath:      d.opt.PanelPath,
		panelPassword:  d.opt.PanelPassword,
		uuid:           d.opt.UUID,
		trojanPassword: d.opt.TrojanPassword,
		wsPath:         d.opt.WSPath,
	}

	// controlName / dataName 是**本次实际要用的**项目名。
	//
	// 更新模式下会被清单覆盖（同一实例原地更新）；
	// 全新模式下保持调用方给的值，为空则在归属校验**之前**补随机名。
	controlName := strings.TrimSpace(d.opt.ControlProject)
	dataName := strings.TrimSpace(d.opt.DataProject)
	// previousDataProject 必须在被 manifest 覆盖**之前**捕获，
	// 否则两边相等就判断不出「换过名」。
	previousDataProject := ""

	if manifest != nil && d.opt.Mode != "fresh" {
		d.log(fmt.Sprintf("· 检测到已有部署（%s），进入更新模式", manifest.At))
		controlName = manifest.ControlProject
		dataName = manifest.DataProject
		previousDataProject = manifest.DataProject
		d.result.Control.Name = controlName
		d.result.Data.Name = dataName
		d.result.Control.Subdomain = manifest.ControlSubdomain
		d.result.Data.Subdomain = manifest.DataSubdomain

		if d.opt.KeepCredentials {
			d.log("· 沿用已有 UUID / WS 路径 / 面板凭据（客户端订阅地址不变）")
			eff = mergeCredentials(eff, manifest.Credentials)
			d.log("  · UUID：" + eff.uuid)
			d.log("  · WS 路径：" + eff.wsPath)
		}

		// 同版本跳过：避免无谓触发平台审核
		if d.opt.SkipSameVersion && d.opt.LocalBuild != "" && manifest.Build == d.opt.LocalBuild {
			d.log("✅ 线上已是最新版本（" + d.opt.LocalBuild + "），跳过部署")
			d.result.PanelPath = eff.panelPath
			d.result.UUID = eff.uuid
			d.result.WSPath = eff.wsPath
			d.result.PanelPassword = eff.panelPassword
			d.result.Skipped = true
			return &d.result, nil
		}
		if manifest.Build != "" && d.opt.LocalBuild != "" && manifest.Build != d.opt.LocalBuild {
			d.log(fmt.Sprintf("· 版本变化：%s → %s", manifest.Build, d.opt.LocalBuild))
		}
		// 内核的 semver 变化也要说一声 —— 用户能据此判断「线上是不是比我旧」
		if manifest.KernelVersion != "" && d.opt.LocalKernelVersion != "" &&
			manifest.KernelVersion != d.opt.LocalKernelVersion {
			d.log(fmt.Sprintf("· 内核版本变化：%s → %s", manifest.KernelVersion, d.opt.LocalKernelVersion))
		}
	} else if manifest != nil && d.opt.Mode == "fresh" {
		d.log("· 指定了首次部署模式，忽略已有清单")
	} else {
		d.log("· 未检测到已有部署，进入首次部署模式")
	}

	// ---------------- 0b. 项目名兜底（必须在归属校验之前） ----------------
	//
	// 与 CLI 的 deployPagesSplit（packages/cli/src/deploy/pages-deploy.ts）
	// **顺序完全一致**：更新模式已在上面按清单填好；走到这里仍为空的
	// （首次部署 + 调用方留空，如 GUI 的可选项目名输入框）生成随机名。
	//
	// ⚠️ 顺序不能颠倒 —— 归属校验比对的是**即将实际使用的项目名**。
	//
	// 若「先校验后随机」，校验用的就是用户原始输入（可能为空串），
	// 空串会被误判成 owned → 「全新部署」复用同一个 KV 时，
	// 会把另一个现役实例的清单认成自己的 → 用新凭据覆盖 CONFIG
	// → 老实例的客户端节点全部失效（跨账户串号）。
	if controlName == "" {
		controlName = RandomWorkerName()
	}
	if dataName == "" {
		dataName = RandomWorkerName()
	}
	d.result.Control.Name = controlName
	d.result.Data.Name = dataName

	// ---------------- 0c. 归属校验（写入任何键之前） ----------------
	//
	// ⚠️ 必须在「创建项目 / 写 KV / 部署」之前。
	// 越界写入会直接改坏别人的线上项目（订阅指向错误 UUID、
	// 面板路径与密码被覆盖、会话可跨实例复用），事后极难清理。
	//
	// 校验用的是**解析后的** controlName（对照 CLI）：
	//   - 更新模式 → 来自清单 → 同一个实例的原地更新判为 owned，不被误拒
	//   - 全新模式 → 随机名 → 与清单里的名字必不相等 → 判为 occupied
	//     （必须换 KV，或用户显式勾选「强制」接管）
	if err := d.assertKvOwnership(ctx, manifest, controlName); err != nil {
		return nil, err
	}

	// 首次部署：缺项的凭据生成随机值
	if eff.panelPath == "" {
		eff.panelPath = RandomPanelPath()
	}
	if eff.panelPassword == "" {
		eff.panelPassword = RandomPassword()
	}
	if eff.uuid == "" {
		eff.uuid = RandomUUID()
	}
	if eff.trojanPassword == "" {
		eff.trojanPassword = RandomPassword()
	}
	if eff.wsPath == "" {
		eff.wsPath = RandomWSPath()
	}
	d.result.PanelPath = eff.panelPath
	d.result.UUID = eff.uuid
	d.result.WSPath = eff.wsPath
	d.result.PanelPassword = eff.panelPassword

	// ---------------- 0d. 数据面部署形态 ----------------
	//
	// 未显式指定时**沿用清单里的形态**（而不是无脑回落到 pages）：
	// 否则「一个 Workers 实例被顺手更新一次」就会被悄悄改成 Pages。
	prevDataMode := "pages"
	if manifest != nil && manifest.DataPlaneMode == "workers" {
		prevDataMode = "workers"
	}
	dataMode := strings.TrimSpace(d.opt.DataPlaneMode)
	if dataMode != "pages" && dataMode != "workers" {
		dataMode = prevDataMode
	}
	modeSwitched := manifest != nil && dataMode != prevDataMode
	targetHost := strings.TrimSpace(d.opt.DataHost)
	if targetHost == "" && manifest != nil {
		targetHost = strings.TrimSpace(manifest.DataCustomDomain)
	}
	if modeSwitched {
		from, to := "Pages", "Workers"
		if dataMode == "pages" {
			from, to = "Workers", "Pages"
		}
		d.log(fmt.Sprintf("⚠ 数据面部署形态变更：%s → %s", from, to))
		d.log("  → 新数据面部署成功后，会自动删除旧的数据面并迁移域名")
	}
	d.result.DataPlaneMode = dataMode

	// Workers 模式的权限预检必须发生在**创建任何资源之前**。
	//
	// 绑定自定义域名要额外的「账号级 Workers Routes」与「域级 DNS」权限，
	// 这两项与 Pages 部署用的三项权限完全不相交。若先传了脚本再撞权限墙，
	// 账号里就会留下一个没域名、不接流量的孤儿 Worker，而用户只看到「部署失败」。
	//
	// ⚠️ 预检用的域名要包含「从旧 Pages 项目现读出来的那个」：
	// 清单里只记部署时见过的域名，用户在控制台手动绑的不在清单里。
	oldPagesHost := ""
	if dataMode == "workers" && prevDataMode == "pages" && previousDataProject != "" {
		oldPagesHost = d.findCustomDomain(ctx, previousDataProject)
	}
	switchHostPreview := targetHost
	if switchHostPreview == "" {
		switchHostPreview = oldPagesHost
	}

	var workersZone *cfapi.Zone
	if dataMode == "workers" {
		z, perr := d.preflightWorkersDataPlane(ctx, switchHostPreview, oldPagesHost != "" && switchHostPreview == oldPagesHost)
		if perr != nil {
			return nil, perr
		}
		workersZone = z
	}

	// ---------------- 1. 创建 Pages 项目（数据面按形态决定） ----------------
	//
	// 控制面**永远**在 Pages：面板 + 订阅 + 探针不含出站 TCP，Pages 上最稳。
	ensurePagesProject := func(label, name string) {
		proj, err := d.client.CreatePagesProject(ctx, d.opt.AccountID, name, "main")
		if err != nil {
			// 「项目已存在」的错误码不固定（实测是无 code 的 800 型错误），
			// 因此按消息内容判断，覆盖原地更新场景。
			if isAlreadyExists(err) {
				if p2, e2 := d.client.GetPagesProject(ctx, d.opt.AccountID, name); e2 == nil && p2 != nil {
					d.log(fmt.Sprintf("· %s项目 %s 已存在，复用它（%s）", label, name, p2.Subdomain))
					d.setSlotSubdomain(label, p2.Subdomain)
				} else {
					d.warn("无法读取已存在的" + label + "项目 " + name)
				}
			} else {
				d.warn(fmt.Sprintf("创建%s项目 %s 失败：%v", label, name, err))
			}
			return
		}
		d.log(fmt.Sprintf("✅ 已创建%s项目 %s（%s）", label, name, proj.Subdomain))
		d.setSlotSubdomain(label, proj.Subdomain)
	}

	ensurePagesProject("控制面", controlName)
	if dataMode == "pages" {
		ensurePagesProject("数据面", dataName)
	} else {
		d.log("· 数据面部署形态：Workers（不创建 Pages 数据面项目）")
	}
	// ---------------- 2. 配置环境变量与 KV（必须在部署前） ----------------
	if d.result.Control.Subdomain != "" {
		d.configureProject(ctx, controlName, "控制面", eff)
	}
	if dataMode == "pages" && d.result.Data.Subdomain != "" {
		d.configureProject(ctx, dataName, "数据面", eff)
	}

	// ---------------- 2b. 把本次凭据写入 KV 的 CONFIG 键 ----------------
	//
	// 内核优先级是 KV(CONFIG) > 环境变量 > 默认值，
	// 不写 KV 的话环境变量会被旧值压过（用户拿新密码登不进去）。
	if err := d.writeEffectiveConfig(ctx, eff); err != nil {
		d.warn("写入 KV 配置失败：" + err.Error() + "（会导致面板密码/WS 路径不生效）")
	}

	// ---------------- 3. 部署：先数据面 ----------------
	// 读取旧数据面的自定义域名（用于换名后迁移）
	dataCustomDomain := ""
	if dataMode == "pages" && previousDataProject != "" {
		dataCustomDomain = d.findCustomDomain(ctx, previousDataProject)
		if dataCustomDomain != "" {
			d.log(fmt.Sprintf("· 旧数据面项目 %s 绑定了自定义域名 %s，将自动迁移",
				previousDataProject, dataCustomDomain))
		}
	}
	// 从 Workers 换回 Pages 时，域名只可能来自清单或本次指定
	if dataMode == "pages" && prevDataMode == "workers" && dataCustomDomain == "" {
		dataCustomDomain = targetHost
	}

	if dataMode == "workers" {
		/* ---------- 数据面：Workers ---------- */

		switchingFromPages := modeSwitched && prevDataMode == "pages"

		// 换形态时真正要迁到 Workers 的域名。
		//
		// 优先级：本次指定 > 清单里记的 > **旧 Pages 项目上现读的**（见 0d 的 oldPagesHost）。
		//
		// 第三档不能省：清单只记「部署时见过」的域名，用户在控制台手动绑的
		// 不在清单里。漏掉它的后果很重 —— 下面的收尾会删除旧 Pages 项目，
		// 而**自定义域名是跟着项目走的**，项目一删，用户唯一的入口就没了。
		switchHost := targetHost
		if switchHost == "" {
			switchHost = oldPagesHost
		}
		if switchingFromPages && oldPagesHost != "" {
			if targetHost == "" {
				d.log("· 将把旧 Pages 数据面的自定义域名 " + oldPagesHost + " 迁移到 Workers")
			} else if targetHost != oldPagesHost {
				d.warn(fmt.Sprintf(
					"旧数据面的自定义域名 %s 与本次指定的 %s 不同：\n"+
						"  → 只有 %s 会绑到 Workers；删除旧项目后 %s 会解绑（DNS 记录也会一起消失）。\n"+
						"  → 想保留原域名就把「自定义域名」填成它。",
					oldPagesHost, targetHost, targetHost, oldPagesHost))
			}
		}

		// 同一个域名不能同时挂在 Pages 项目与 Worker 上，必须先解绑旧的。
		// 这一步会让旧实例短暂失去域名 —— 因此失败时必须回滚（见下面）。
		if switchingFromPages && switchHost != "" && previousDataProject != "" {
			if err := d.client.RemovePagesDomain(ctx, d.opt.AccountID, previousDataProject, switchHost); err == nil {
				d.log(fmt.Sprintf("· 已从旧 Pages 数据面 %s 解绑域名 %s（准备迁到 Workers）",
					previousDataProject, switchHost))
			}
		}

		host, custom, werr := d.deployWorkersDataPlane(ctx, dataName, eff, switchHost, workersZone)
		if werr != nil {
			// 回滚：把域名还给旧 Pages 数据面，别让用户连一个不存在的域名
			if switchingFromPages && switchHost != "" && previousDataProject != "" {
				if rerr := d.client.AddPagesDomain(ctx, d.opt.AccountID, previousDataProject, switchHost); rerr == nil {
					d.log("· 已把域名回滚到旧 Pages 数据面")
				} else {
					d.warn(fmt.Sprintf("域名 %s 回滚失败，请手动到 Cloudflare 控制台把它绑回 %s。",
						switchHost, previousDataProject))
				}
			}
			return nil, fmt.Errorf("Workers 数据面部署失败：%w", werr)
		}
		d.result.Data.Name = dataName
		d.result.Data.Subdomain = host
		dataCustomDomain = custom

		// 新数据面已上线 → 删掉旧 Pages 数据面（换形态的唯一收尾动作）。
		//
		// ⚠️ 但**没有可用自定义域名时不删**：此时新数据面跑在 *.workers.dev 上，
		// 多数网络下直连不可访问。旧 Pages 项目（及其域名）是用户唯一的可用入口，
		// 删掉等于把「还能用」的实例亲手拆了。
		newHostUsable := host != "" && !strings.HasSuffix(host, ".workers.dev")
		if switchingFromPages && previousDataProject != "" {
			if !newHostUsable {
				d.warn(fmt.Sprintf(
					"未迁移到自定义域名（新数据面是 %s），因此**保留**了旧 Pages 数据面 %s。\n"+
						"  → *.workers.dev 直连无法访问，节点会连不上；给它补一个自定义域名后重跑，"+
						"迁移成功才会自动删除旧项目。", host, previousDataProject))
			} else if err := d.client.DeletePagesProject(ctx, d.opt.AccountID, previousDataProject); err != nil {
				d.warn(fmt.Sprintf("删除旧 Pages 数据面失败（%s）：%v\n"+
					"  → 它已经不再接收流量，可到控制台手动删除。", previousDataProject, err))
			} else {
				d.log("✅ 已删除被替换的旧 Pages 数据面项目：" + previousDataProject)
			}
		}
	} else {
		/* ---------- 数据面：Pages ---------- */

		// 从 Workers 换回 Pages：Pages 的变量必须在部署前配好
		if modeSwitched && prevDataMode == "workers" {
			ensurePagesProject("数据面", dataName)
			if d.result.Data.Subdomain != "" {
				d.configureProject(ctx, dataName, "数据面", eff)
			}
		}

		dataAttempt := d.deployWithBlockRetry(ctx, deployAttemptParams{
			preferredName: dataName,
			code:          d.opt.DataScript,
			label:         "数据面",
			eff:           eff,
			oldProject:    previousDataProject,
			customDomain:  dataCustomDomain,
		})
		if dataAttempt != nil {
			d.result.Data.Name = dataAttempt.project
			d.result.Data.Subdomain = dataAttempt.subdomain

			// 形态切换收尾：摘掉旧 Worker 的域名 → 绑到新 Pages 项目 → 删旧 Worker
			if modeSwitched && prevDataMode == "workers" && previousDataProject != "" {
				detachedHost := d.detachWorkerHostname(ctx, previousDataProject)
				if detachedHost != "" {
					d.log("· 已从旧 Workers 数据面解绑域名 " + detachedHost)
				}

				host := dataCustomDomain
				if host == "" {
					host = detachedHost
				}
				moved := true
				if host != "" {
					if err := d.client.AddPagesDomain(ctx, d.opt.AccountID, d.result.Data.Name, host); err != nil {
						moved = false
						d.warn(fmt.Sprintf("自定义域名迁移失败（%s → %s）：%v\n"+
							"  → 请手动到 Cloudflare 控制台把该域名绑到 %s，否则订阅地址会失效。",
							host, d.result.Data.Name, err, d.result.Data.Name))
						// 迁移失败：把域名还给旧 Worker，且**不删**旧 Worker
						if zone, zerr := d.resolveZoneForHost(ctx, host); zerr == nil && zone != nil {
							if _, aerr := d.client.AttachWorkerDomain(ctx, d.opt.AccountID, host, previousDataProject, zone.ID); aerr == nil {
								d.log("· 已把域名回滚到旧 Workers 数据面")
							}
						}
					} else {
						d.log("✅ 自定义域名已迁移到 Pages 数据面：" + host)
						dataCustomDomain = host
					}
				}

				if moved {
					if err := d.deleteWorkersDataPlane(ctx, previousDataProject); err != nil {
						d.warn(fmt.Sprintf("删除旧 Workers 数据面失败（%s）：%v\n"+
							"  → 它已经不再接收流量，可到控制台手动删除。", previousDataProject, err))
					}
				}
			}
		}
	}

	// ⚠️ 数据面换名后必须重配控制面。
	//
	// 控制面的环境变量是**部署前**配好的，那时 DATA_HOST 还是旧域名。
	// 数据面因 8000119 换名重建后域名变了 → 控制面 DATA_HOST 仍指向
	// **已删除的旧域名** → 订阅里 sni/host 全部指向不存在的域名 → 所有节点失效。
	if d.result.Data.Subdomain != "" && d.result.Control.Name != "" {
		d.syncControlDataHost(ctx, eff)
	}

	// ---------------- 3b. 部署控制面 ----------------
	controlAttempt := d.deployWithBlockRetry(ctx, deployAttemptParams{
		preferredName: controlName,
		code:          d.opt.ControlScript,
		label:         "控制面",
		eff:           eff,
	})
	if controlAttempt != nil {
		d.result.Control.Name = controlAttempt.project
		d.result.Control.Subdomain = controlAttempt.subdomain
	}

	// ---------------- 4. 写回部署清单 ----------------
	if d.result.Control.Subdomain != "" && d.result.Data.Subdomain != "" {
		if err := d.writeManifest(ctx, manifest, eff, dataCustomDomain); err != nil {
			d.warn("写入部署清单失败：" + err.Error())
		} else {
			d.log("· 已记录部署清单，下次更新会自动识别同源项目")
		}
	}

	return &d.result, nil
}

// ---------- 内部实现 ----------

func (d *Deployer) validate() error {
	var problems []string
	if strings.TrimSpace(d.opt.Token) == "" {
		problems = append(problems, "缺少 API Token")
	}
	if strings.TrimSpace(d.opt.AccountID) == "" {
		problems = append(problems, "缺少账号 ID")
	}
	if strings.TrimSpace(d.opt.KVNamespaceID) == "" {
		problems = append(problems, "缺少 KV 命名空间 ID")
	}
	if len(d.opt.ControlScript) == 0 {
		problems = append(problems, "控制面产物为空（control.js）")
	}
	if len(d.opt.DataScript) == 0 {
		problems = append(problems, "数据面产物为空（dataplane.js）")
	}
	if len(problems) > 0 {
		return fmt.Errorf("部署参数不合法：\n  - %s", strings.Join(problems, "\n  - "))
	}
	return nil
}

func mergeCredentials(cur effective, m Credentials) effective {
	if cur.panelPath == "" {
		cur.panelPath = m.PanelPath
	}
	if cur.panelPassword == "" {
		cur.panelPassword = m.PanelPassword
	}
	if cur.uuid == "" {
		cur.uuid = m.UUID
	}
	if cur.trojanPassword == "" {
		cur.trojanPassword = m.TrojanPassword
	}
	if cur.wsPath == "" {
		cur.wsPath = m.WSPath
	}
	return cur
}

func (d *Deployer) setSlotSubdomain(label, subdomain string) {
	if label == "控制面" {
		d.result.Control.Subdomain = subdomain
	} else {
		d.result.Data.Subdomain = subdomain
	}
}

func isAlreadyExists(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "already exists")
}

// Ownership 是 KV 命名空间的归属判定。
type Ownership string

const (
	// OwnEmpty 空命名空间，可用
	OwnEmpty Ownership = "empty"
	// OwnOwned 清单属于本实例，可原地更新
	OwnOwned Ownership = "owned"
	// OwnOccupied 清单属于另一个 CFPilot 实例，必须拒绝
	OwnOccupied Ownership = "occupied"
	// OwnForeign 被旧版第三方实现占用（存在小写 config 键）—— **必须拒绝**
	OwnForeign Ownership = "foreign"
	// OwnStale 含 CFPilot 的 CONFIG 但无清单（残留配置），必须拒绝
	OwnStale Ownership = "stale"
)

// inspectKvOwnership 探测 KV 归属。
//
// 与 CLI 的 packages/cli/src/deploy/pages-deploy.ts 的 inspectKvOwnership
// **一一对应**，五种判定完全一致（AGENTS.md §1.3）：
//
//	empty    空命名空间
//	owned    清单属于本实例
//	occupied 清单属于另一个 CFPilot 实例
//	foreign  含小写 config 键（旧版第三方实现）
//	stale    含大写 CONFIG 但无清单（残留配置）
//
// ## 为什么不能只看清单
//
// KV 里的键是**全局平铺**的，没有实例前缀。判断「这个 KV 属于谁」
// 唯一可靠依据是清单键；但清单可能被删、被手工改写，
// 也可能是旧版第三方实现早就占着的命名空间（那种情况根本没有清单）。
// 所以还要探测两个配置键：
//   - 小写 `config`   → 旧版第三方实现在用 → foreign
//   - 大写 `CONFIG`   → CFPilot 残留 → stale
//
// ## ⚠️ foreign 为什么是硬阻断
//
// CFPilot 已是纯自研数据面（vendor 移除），
// 不与旧版第三方实现共用 KV：会共享配额、混淆 schema、让排查变难。
// 因此 foreign **连 Force 都不放行** —— 要部署就换一个干净的 KV。
//
// ## ⚠️ controlProject 必须是「即将实际使用的项目名」
//
// 比对是**严格相等**（CLI 同款）。绝不能有「请求里的项目名为空 ⇒ 认领」
// 这条规则：GUI 的项目名框是可选的（默认空串），
// 空串一旦被当成 owned，「全新部署」复用同一个 KV 时就会
// 用新凭据覆盖另一个现役实例的 CONFIG（跨账户串号）。
func (d *Deployer) inspectKvOwnership(ctx context.Context, manifest *Manifest, controlProject string) (Ownership, string) {
	if manifest != nil {
		// 严格相等：清单里的控制面项目名必须与本次实际使用的项目名一致。
		if manifest.ControlProject == controlProject {
			return OwnOwned, fmt.Sprintf("已由 CFPilot 部署（控制面 %s / 数据面 %s）",
				manifest.ControlProject, manifest.DataProject)
		}
		return OwnOccupied, fmt.Sprintf("已被另一个 CFPilot 实例占用（控制面 %s / 数据面 %s，部署于 %s）",
			manifest.ControlProject, manifest.DataProject, manifest.At)
	}

	// 没有清单：探测别的产品留下的痕迹
	//
	// ⚠️ **「读不到」不能当成「不存在」**。
	//
	// 旧实现用 `GetKVValue`（不存在与失败都返回 false），
	// 于是「KV 属于别的账号」「Token 没权限」「网络断了」时
	// 两个判据全为 false → 落到 `OwnEmpty`（**不阻断**）
	// → 继续建项目、写 KV → 孤儿 Pages 项目 + 半成品实例。
	//
	// 现在用三态读取：读不到时按 `OwnOccupied` 处理（**不可放行**）。
	// ⚠️ 五分支语义保持不变（不新增第六个分支）——
	// 与 CLI 版 packages/cli/src/deploy/pages-deploy.ts 一致
	// （AGENTS.md §1.3 / §2.2）。
	legacyConfig, legacyState, legacyErr := d.client.GetKVValueState(ctx, d.opt.AccountID, d.opt.KVNamespaceID, "config")
	if legacyState == cfapi.KVError {
		return OwnOccupied, fmt.Sprintf("无法确认 KV 归属（读取 config 键失败：%v）—— 请检查 Token 权限与网络后重试", legacyErr)
	}
	if legacyState == cfapi.KVFound {
		_ = legacyConfig
		return OwnForeign, "含旧版第三方实现的 config 键，该命名空间正被其它项目使用"
	}

	cfpilotConfig, cfpilotState, cfpilotErr := d.client.GetKVValueState(ctx, d.opt.AccountID, d.opt.KVNamespaceID, ConfigKey)
	if cfpilotState == cfapi.KVError {
		return OwnOccupied, fmt.Sprintf("无法确认 KV 归属（读取 CONFIG 键失败：%v）—— 请检查 Token 权限与网络后重试", cfpilotErr)
	}
	if cfpilotState == cfapi.KVFound {
		_ = cfpilotConfig
		return OwnStale, "含 CFPilot 的 CONFIG 键但没有部署清单（残留配置，可能是清单被删或手工写入）"
	}
	return OwnEmpty, "空命名空间"
}

// assertKvOwnership 校验 KV 归属，不通过则中止部署。
//
// 越界写入会**直接改坏别人的线上项目**：订阅指向错误 UUID、
// 面板路径与密码被覆盖、会话可跨实例复用，事后极难清理。
// 因此这里一律返回 error（不是 warnings）。
//
// Force 只对 occupied / stale 生效；foreign 是硬约束，Force 也不放行。
//
// controlProject 是**本次实际使用的**控制面项目名（对照 CLI 的
// assertKvOwnership：传空串会被误判成 occupied）。
func (d *Deployer) assertKvOwnership(ctx context.Context, manifest *Manifest, controlProject string) error {
	verdict, detail := d.inspectKvOwnership(ctx, manifest, controlProject)

	switch verdict {
	case OwnEmpty, OwnOwned:
		d.log("· KV 归属校验通过：" + detail)
		return nil

	case OwnForeign:
		// 硬阻断：连 Force 都不放行
		return fmt.Errorf(
			"该 KV 命名空间%s。\n"+
				"  CFPilot 的数据面已完全自研，不再与旧版第三方实现共用同一命名空间。\n"+
				"  → 请为 CFPilot 新建一个独立的 KV。\n"+
				"  → 此判定不可用「强制」绕过。", detail)

	case OwnOccupied:
		if d.opt.Force {
			d.log("⚠ KV 被另一实例占用，但已指定强制覆盖：" + detail)
			return nil
		}
		return fmt.Errorf(
			"该 KV 命名空间%s。\n"+
				"  一个 KV 命名空间只能承载一个 CFPilot 部署实例（内核的 KV 键全局平铺，无实例前缀）。\n"+
				"  → 请改用其他 KV 命名空间，或新建一个。\n"+
				"  → 确认要接管时勾选「强制」。", detail)

	case OwnStale:
		if d.opt.Force {
			d.log("⚠ KV 含残留配置，但已指定强制覆盖：" + detail)
			return nil
		}
		return fmt.Errorf(
			"该 KV 命名空间%s。\n"+
				"  → 继续部署会覆盖其中的既有配置。\n"+
				"  → 如需本次部署独占，请新建独立 KV。\n"+
				"  → 确认要接管时勾选「强制」。", detail)
	}

	return nil
}

// readManifest 读部署清单；不存在时返回 (nil, nil)。
func (d *Deployer) readManifest(ctx context.Context) (*Manifest, error) {
	raw, ok := d.client.GetKVValue(ctx, d.opt.AccountID, d.opt.KVNamespaceID, ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var m Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		// 清单损坏不该阻断部署，当作没有清单处理
		d.warn("部署清单格式损坏，按首次部署处理")
		return nil, nil
	}
	return &m, nil
}

func (d *Deployer) writeManifest(ctx context.Context, old *Manifest, eff effective, customDomain string) error {
	// ⚠️ 读不到版本号就写空串，绝不写 "unknown"。
	// 假值会让「检查状态」显示「线上内核 unknown ≠ 本地 xxx」，用户看不懂。
	build := strings.TrimSpace(d.opt.LocalBuild)

	// 内核的语义化版本（semver）。同样读不到就写空串。
	kernelVersion := strings.TrimSpace(d.opt.LocalKernelVersion)

	// 自定义域名：本次迁过来的，或旧项目上原有的（下次更新还要靠它迁移）
	if customDomain == "" && old != nil {
		customDomain = old.DataCustomDomain
	}

	m := Manifest{
		V:                1,
		KVNamespaceID:    d.opt.KVNamespaceID,
		ControlProject:   d.result.Control.Name,
		DataProject:      d.result.Data.Name,
		ControlSubdomain: d.result.Control.Subdomain,
		DataSubdomain:    d.result.Data.Subdomain,
		DataCustomDomain: customDomain,
		// 部署形态：更新时靠它识别「用户是否改过数据面形态」
		DataPlaneMode: d.result.DataPlaneMode,
		Build:            build,
		KernelVersion:    kernelVersion,
		At:               time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Credentials: Credentials{
			PanelPath:      eff.panelPath,
			PanelPassword:  eff.panelPassword,
			UUID:           eff.uuid,
			TrojanPassword: eff.trojanPassword,
			WSPath:         eff.wsPath,
		},
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return d.client.SetKVValue(ctx, d.opt.AccountID, d.opt.KVNamespaceID, ManifestKey, string(raw))
}

// writeEffectiveConfig 把生效的凭据写进 KV 的 CONFIG 键。
//
// ⚠️ 写的是**大写** `CONFIG`（CFPilot 数据面读它），
// 绝不是小写 `config`（那是旧版第三方实现的键，往里写会整体覆盖共栖项目配置）。
//
// ## ⚠️ 必须**合并**而不是整体覆盖
//
// 对照 CLI 的 writeEffectiveConfig
// （packages/cli/src/deploy/pages-deploy.ts：`{ ...existing, uuid, ... }`）：
//
// 整体覆盖会把用户在面板里配过的 40+ 个配置项
// （poolOfficial / poolManual / proxyIp / socks5 / httpProxy / relayPool /
// subDomain / resolvePreferred …）**全部抹掉** —— 面板保存一次就丢一次，
// 用户以为保存了，其实下次部署就被覆盖。
//
// 旧值读不到或解析失败时按空 map 处理（下面会写全凭据字段）。
func (d *Deployer) writeEffectiveConfig(ctx context.Context, eff effective) error {
	// 读旧值，保留用户手动配置的字段（优选池 / 代理池 / 订阅域名等）
	cfg := map[string]any{}
	if raw, ok := d.client.GetKVValue(ctx, d.opt.AccountID, d.opt.KVNamespaceID, ConfigKey); ok {
		if trimmed := strings.TrimSpace(raw); trimmed != "" {
			var existing map[string]any
			// ⚠️ 必须判 nil：JSON 文本 "null" 能解析成功但结果是 nil map，
			// 直接赋值会让后面的写入 panic（assignment to entry in nil map）。
			if err := json.Unmarshal([]byte(trimmed), &existing); err == nil && existing != nil {
				cfg = existing
			} else {
				d.warn("已有 KV 配置解析失败，本次只写入凭据字段（面板里配过的设置会丢失）")
			}
		}
	}

	// 覆盖本次部署的凭据类字段；其余字段保持旧值不动。
	cfg["uuid"] = eff.uuid
	cfg["trojanPassword"] = eff.trojanPassword
	cfg["wsPath"] = eff.wsPath
	cfg["enableTrojan"] = d.opt.EnableTrojan
	cfg["enableXhttp"] = d.opt.EnableXHTTP
	if d.opt.ResolvePreferred != nil {
		cfg["resolvePreferred"] = *d.opt.ResolvePreferred
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	d.log("· 正在写入 KV 配置（CONFIG 键）…")
	if err := d.client.SetKVValue(ctx, d.opt.AccountID, d.opt.KVNamespaceID, ConfigKey, string(raw)); err != nil {
		return err
	}
	d.log("✅ 已写入 KV 配置")
	return nil
}

// configureProject 配 KV 绑定与环境变量。
//
// KV 绑定两个名字：
//   - `KV`：CFPilot 内核读的名字
//   - `K` ：兼容旧版实现的名字
//
// 少绑一个就会有一侧读不到配置。
func (d *Deployer) configureProject(ctx context.Context, project, label string, eff effective) {
	var envVars map[string]cfapi.PageVar

	if label == "控制面" {
		v := map[string]cfapi.PageVar{
			"PANEL_PATH":     {Value: eff.panelPath, Type: "plain_text"},
			"PANEL_PASSWORD": {Value: eff.panelPassword, Type: "secret_text"},
			// 拆分部署：控制面用 DATA_HOST 指定节点域名
			"DATA_HOST": {Value: d.result.Data.Subdomain, Type: "plain_text"},
		}
		if d.opt.ScannerToken != "" {
			v["SCANNER_TOKEN"] = cfapi.PageVar{Value: d.opt.ScannerToken, Type: "secret_text"}
		}
		envVars = v
	} else {
		envVars = map[string]cfapi.PageVar{
			"UUID":            {Value: eff.uuid, Type: "secret_text"},
			"TROJAN_PASSWORD": {Value: eff.trojanPassword, Type: "secret_text"},
			// WS 路径：内核读 WS_PATH 或 PATH，两个都注入
			"WS_PATH":       {Value: eff.wsPath, Type: "plain_text"},
			"PATH":          {Value: eff.wsPath, Type: "plain_text"},
			"ENABLE_TROJAN": {Value: boolStr(d.opt.EnableTrojan), Type: "plain_text"},
			"ENABLE_XHTTP":  {Value: boolStr(d.opt.EnableXHTTP), Type: "plain_text"},
		}
		if d.opt.ResolvePreferred != nil {
			envVars["RESOLVE_PREFERRED"] = cfapi.PageVar{
				Value: boolStr(*d.opt.ResolvePreferred), Type: "plain_text",
			}
		}
	}

	if err := d.client.UpdatePagesEnv(ctx, d.opt.AccountID, project, envVars); err != nil {
		d.warn(fmt.Sprintf("%s 配置失败：%v（会导致部署后变量不生效）", label, err))
		return
	}
	// KV 绑定必须单独设（UpdatePagesEnv 只处理 env_vars）
	if err := d.client.BindPagesKV(ctx, d.opt.AccountID, project,
		map[string]string{"KV": d.opt.KVNamespaceID, "K": d.opt.KVNamespaceID}); err != nil {
		d.warn(fmt.Sprintf("%s 绑定 KV 失败：%v（会导致读不到配置）", label, err))
		return
	}
	d.log("✅ " + label + "已配置 KV 与环境变量")
}

// findCustomDomain 找旧项目上的自定义域名。
//
// ⚠️ **必须用 /domains 子接口，不能用 project.domains**（真机实测）：
// 刚绑定的域名在 initializing 期间不会出现在 project.domains 里，
// 只有 active 的才列出。若此时恰好触发 8000119 换名，就会漏掉该域名
// → 新项目没继承它 → 用户订阅地址失效。
func (d *Deployer) findCustomDomain(ctx context.Context, project string) string {
	isCustom := func(s string) bool {
		return s != "" && !strings.HasSuffix(s, ".pages.dev")
	}

	// 1) 优先 /domains（含未生效状态）
	if domains, err := d.client.ListPagesDomains(ctx, d.opt.AccountID, project); err == nil {
		for _, dm := range domains {
			if isCustom(dm.Name) {
				return dm.Name
			}
		}
	}
	// 2) 回落 project.domains
	if p, err := d.client.GetPagesProject(ctx, d.opt.AccountID, project); err == nil && p != nil {
		for _, dm := range p.Domains {
			if isCustom(dm) {
				return dm
			}
		}
	}
	return ""
}

// syncControlDataHost 数据面域名变化后，把控制面的 DATA_HOST 同步过去。
func (d *Deployer) syncControlDataHost(ctx context.Context, eff effective) {
	expected := d.result.Data.Subdomain
	p, err := d.client.GetPagesProject(ctx, d.opt.AccountID, d.result.Control.Name)
	if err != nil || p == nil {
		d.warn(fmt.Sprintf("同步控制面 DATA_HOST 失败：%v", err))
		return
	}
	current := ""
	if p.DeploymentConfigs.Production.EnvVars != nil {
		if v, ok := p.DeploymentConfigs.Production.EnvVars["DATA_HOST"]; ok {
			current = v.Value
		}
	}
	// ⚠️ 这里**不能加 `current != ""`** 兜底：首次部署 Workers 数据面时，
	// 控制面的 DATA_HOST 在部署前是空串（那一步还不知道数据面域名），
	// 用「非空才比对」会直接跳过同步 → 订阅里的节点域名是空的。
	if current != expected {
		d.log(fmt.Sprintf("⚠ 控制面 DATA_HOST 仍指向旧域名 %s，正在同步为 %s", current, expected))
		d.configureProject(ctx, d.result.Control.Name, "控制面", eff)
		d.log("✅ 控制面 DATA_HOST 已同步为 " + expected)
	}
}

// deployAttemptParams 是 deployWithBlockRetry 的参数。
type deployAttemptParams struct {
	preferredName string
	code          []byte
	label         string
	eff           effective
	// oldProject 是被替换掉的旧项目名（更新部署时才有）
	oldProject string
	// customDomain 是需要迁移的自定义域名
	customDomain string
}

// deployAttemptResult 是一次部署尝试的结果。
type deployAttemptResult struct {
	project      string
	subdomain    string
	deploymentID string
}

// sameProjectAttempts 是同一个项目重试的次数。
//
// 8000119 的风控判定分两种形态：
//  1. 新项目 / 未承载流量的项目：间歇性，原样重试即可成功
//  2. 已服务真实代理流量的数据面项目：持久性，重试无意义
//
// 因此换名之前必须先原样重试：对新项目这是成功率最高的路径；
// 对已承载流量的旧项目，3 次原样重试只是「确认持久封禁」的成本。
const sameProjectAttempts = 3

// deployWithBlockRetry 部署一个项目；命中 8000119 时自动换随机项目名重试。
func (d *Deployer) deployWithBlockRetry(ctx context.Context, p deployAttemptParams) *deployAttemptResult {
	if len(p.code) == 0 {
		d.warn(p.label + "产物为空，跳过部署")
		return nil
	}

	// 候选项目名：首选原名，失败后再换随机名。
	candidates := []string{p.preferredName}
	for i := 0; i < 2; i++ {
		candidates = append(candidates, p.preferredName+"-"+randomSuffix(4))
	}

	for index, name := range candidates {
		for attempt := 1; attempt <= sameProjectAttempts; attempt++ {
			dep, err := d.client.DeployPagesWorker(ctx, cfapi.PagesDeployOptions{
				AccountID:     d.opt.AccountID,
				Project:       name,
				Script:        p.code,
				CommitMessage: "CFPilot desktop deploy",
			})
			if err != nil {
				blocked := isBlocked(err)
				isLast := attempt == sameProjectAttempts

				// ⚠️ 网络错误绝不能当成 8000119 处理
				//
				// 真机日志里出现过：
				//   Post ".../pages/projects": EOF
				//   请求超时：Cloudflare API 无响应
				// 早期实现把这些也走进「8000119 换名重试」分支，
				// 于是报出「连续 3 次被平台拒绝部署（8000119）」——
				// **完全是误判**：平台根本没拒绝，是网络断了。
				//
				// 用户的真实体验是「部署失败，日志说 8000119」，
				// 会误以为是账号被风控，实际上重试一下就能成功。
				//
				// 所以这里区分：
				//   - 网络类错误（EOF / 超时 / 连接重置）→ 直接重试 + 明确提示
				//   - 真正的业务错误（8000119）→ 换名重试
				if isNetworkError(err) {
					if !isLast {
						d.log(fmt.Sprintf("⚠ %s项目 %s 部署时网络中断，%d 次后重试",
							p.label, name, sameProjectAttempts-attempt))
						d.log("  → 这不是账号风控，是到 Cloudflare 的网络不稳定")
						// 退避一下再重试，避免立刻又撞上同一个网络问题
						select {
						case <-ctx.Done():
							return nil
						case <-time.After(time.Duration(attempt) * 1500 * time.Millisecond):
						}
						continue
					}
					d.warn(fmt.Sprintf(
						"%s部署失败：网络无法连接 Cloudflare API（%v）。\n"+
							"  → 这不是账号风控，请检查网络 / 代理后重试", p.label, err))
					return nil
				}

				// 同名重试耗尽：换名再试
				if isLast && index < len(candidates)-1 {
					d.log(fmt.Sprintf("⚠ %s项目 %s 连续 %d 次被平台拒绝部署（8000119）",
						p.label, name, sameProjectAttempts))
					next := candidates[index+1]
					d.log("  → 改用新项目名 " + next + " 重新部署")

					// 换名重试前要先建项目、配变量
					if _, cerr := d.client.CreatePagesProject(ctx, d.opt.AccountID, next, "main"); cerr != nil {
						if !isAlreadyExists(cerr) {
							d.warn(fmt.Sprintf("创建备用%s项目失败：%v", p.label, cerr))
							return nil
						}
					}
					// 注意：换名后控制面的 DATA_HOST 会在上层重新同步
					if proj, e2 := d.client.GetPagesProject(ctx, d.opt.AccountID, next); e2 == nil && proj != nil {
						if p.label == "数据面" {
							d.result.Data.Subdomain = proj.Subdomain
						}
						d.configureProject(ctx, next, p.label, p.eff)
					}
					d.log("  → 已创建并配置 " + next)

					// ⚠️ 换名成功后必须清理旧项目
					//
					// 真机故障：网络抖动导致反复换名重试，账号下堆积了
					// 8 个孤儿项目（4 组 cpdata + 4 组 cpmanager）。
					//
					// 根因：早期只有「8000119 换名成功后」才走
					// migrateAndCleanup（迁移域名 + 删旧项目），
					// 而**网络错误触发的换名完全不清理** ——
					// 新项目建了、旧项目留着，每次重试多一组。
					//
					// 现在：只要换了项目名，就把候选链里所有「非最终项目」
					// 都尝试删掉（含自定义域名迁移）。
					d.cleanupSupersededProjects(ctx, p, next)

					break
				}

				if !isLast {
					d.log(fmt.Sprintf("⚠ %s项目 %s 部署被拒（8000119），%d 次后重试同一项目",
						p.label, name, sameProjectAttempts-attempt))
					d.log("  → 该判定是间歇性的，同名重试通常就能成功")
					continue
				}

				msg := err.Error()
				if blocked {
					msg += "（平台已拒绝该项目；已重试并尝试更换项目名，可在 Cloudflare 控制台查看详情）"
				}
				d.warn(fmt.Sprintf("%s部署失败：%s", p.label, msg))
				return nil
			}

			// 部署请求已受理
			if p.label == "数据面" {
				d.result.Data.Name = name
				d.result.Data.DeploymentID = dep.ID
			} else {
				d.result.Control.Name = name
				d.result.Control.DeploymentID = dep.ID
			}
			d.log(fmt.Sprintf("✅ %s已触发部署：%s（%s）", p.label, name, dep.ID))

			final := d.waitForDeployment(ctx, name, p.label)
			subdomain := ""
			if proj, e := d.client.GetPagesProject(ctx, d.opt.AccountID, name); e == nil && proj != nil {
				subdomain = proj.Subdomain
			}

			if final == "success" {
				d.log(fmt.Sprintf("✅ %s部署完成：%s", p.label, name))
			} else {
				d.warn(fmt.Sprintf("%s部署未确认成功（项目 %s，状态：%s）",
					p.label, name, orUnknown(final)))
			}

			// 换名成功后的收尾，两件事：
			//
			// 1. migrateAndCleanup：处理**清单里的旧实例项目**
			//    （更新部署时旧项目名与新项目名不同）→ 迁域名 + 删旧项目
			// 2. cleanupSupersededProjects：处理**本次尝试链里被淘汰的项目**
			//    （网络抖动 / 8000119 反复重试产生的中间项目）→ 全部清理
			//
			// 两件事互补，缺任何一件都会留下孤儿项目。
			// 用户实测：只做第 1 件事，结果账号下堆了 8 个项目。
			d.migrateAndCleanup(ctx, p, name)
			// ⚠️ 传的是「刚成功的项目名」而不是 index+1
			//
			// 早期写成 candidates[index+1]，那是**下一个候选**（可能根本不存在），
			// 导致清理逻辑误判最终项目 → 把活跃项目当成孤儿删掉
			// （真机故障：清单里 dataProject 还在，实际项目被删）。
			d.cleanupSupersededProjects(ctx, p, name)

			return &deployAttemptResult{project: name, subdomain: subdomain, deploymentID: dep.ID}
		}
	}
	return nil
}

func orUnknown(s string) string {
	if s == "" {
		return "未知"
	}
	return s
}

// isNetworkError 判断是否是「网络层面」的错误（而非平台业务拒绝）。
//
// ## 为什么必须区分
//
// 真机部署时出现过：
//
//	Post ".../pages/projects": EOF
//	请求超时：Cloudflare API 无响应（检查网络或代理）
//
// 这些是**网络问题**，但早期实现与 8000119 共用同一个重试分支，
// 日志里报出「连续 3 次被平台拒绝部署（8000119）」——
// 用户会误以为账号被风控，实际只是网络抖动。
//
// 区分依据：cfapi 把网络错误包装成普通 error（不是 *cfapi.APIError），
// 且消息里含特定网络关键词。
func isNetworkError(err error) bool {
	if err == nil {
		return false
	}
	// 业务错误（*APIError）一律不算网络错误
	var apiErr *cfapi.APIError
	if errors.As(err, &apiErr) {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, kw := range []string{
		"eof", "timeout", "timed out", "deadline exceeded",
		"connection reset", "connection refused", "broken pipe",
		"no such host", "network is unreachable", "tls handshake",
		"\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25", "\u8bf7\u6c42\u8d85\u65f6",
	} {
		if strings.Contains(msg, kw) {
			return true
		}
	}
	return false
}

func isBlocked(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *cfapi.APIError
	if errors.As(err, &apiErr) && apiErr.IsProjectLimit() {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "8000119") || strings.Contains(msg, "has been blocked")
}

// cleanupSupersededProjects 清理被换名淘汰的项目。
//
// ## 为什么需要
//
// 网络抖动（如开启了 TUN 模式的代理）会让部署反复失败并换名重试。
// 早期实现只在「8000119 换名成功后」清理旧项目，**网络错误路径不清理**，
// 结果账号下快速堆积孤儿项目：
//
//	cpdata-ux7t-li8f-9vlk     ← 第 1 次重试建的
//	cpdata-ux7t-li8f-i2t5     ← 第 2 次
//	cpdata-ux7t-li8f-f69z     ← 第 3 次
//	cpdata-ux7t-li8f-6ngd     ← 第 4 次
//	（控制面同样 4 个）
//
// 用户看到的就是「账户里凭空多了很多 Pages 项目」。
//
// ## 清理策略
//
// 只删**本次尝试链里**的项目（candidates[0..finalIndex-1]），
// 绝不碰：
//   - 最终选定的项目（finalIndex 及以后）
//   - 清单里记录的旧实例项目（那是用户正在用的，走 migrateAndCleanup）
//
// 删除前先把自定义域名迁到最终项目（否则用户订阅地址失效）。
func (d *Deployer) cleanupSupersededProjects(
	ctx context.Context,
	p deployAttemptParams,
	finalName string,
) {
	if finalName == "" {
		return
	}

	// 候选链：原始名 + 两个随机后缀名
	// 只清理「以原始名为前缀」且「不等于最终名」的项目
	base := p.preferredName
	if base == "" {
		return
	}

	projects, err := d.client.ListPagesProjects(ctx, d.opt.AccountID)
	if err != nil {
		d.warn("列举项目失败，跳过清理：" + err.Error())
		return
	}

	// ⚠️ 活跃项目保护名单
	//
	// 真机事故：更新部署时 p.preferredName 恰好**等于清单里活跃的数据面项目名**
	// （如 cpdata-ux7t-li8f）。一旦发生换名重试，finalName 变成
	// cpdata-ux7t-li8f-xxxx，下面 `name == base` 就把**活跃项目**命中了，
	// 而它 != finalName，于是被当成「被淘汰的旧项目」删掉。
	//
	// 用户的真实感受是「绑定的数据面项目莫名其妙没了，部署工具又重建了一个」，
	// 而旧项目里的 KV 绑定、域名配置全丢。
	//
	// 所以这里必须显式排除活跃项目：清单里记录的控制面 / 数据面项目，
	// 即使名字匹配前缀也绝不删除。
	activeNames := map[string]bool{}
	if m, err := d.readManifest(ctx); err == nil && m != nil {
		if m.ControlProject != "" {
			activeNames[m.ControlProject] = true
		}
		if m.DataProject != "" {
			activeNames[m.DataProject] = true
		}
	}
	// 本次部署的结果也算活跃（防止顺序问题）
	if d.result.Control.Name != "" {
		activeNames[d.result.Control.Name] = true
	}
	if d.result.Data.Name != "" {
		activeNames[d.result.Data.Name] = true
	}

	for _, proj := range projects {
		name := proj.Name
		if name == finalName {
			continue // 最终项目，绝不动
		}
		// 活跃项目（清单里正在用的）绝不动
		if activeNames[name] {
			d.log(fmt.Sprintf("· 跳过活跃项目 %s（清单正在使用）", name))
			continue
		}
		// 只碰「本次尝试链」里的项目：
		//   等于原始名，或以「原始名-」开头
		if name != base && !strings.HasPrefix(name, base+"-") {
			continue
		}

		// 这个项目可能压根没建成功（网络失败在创建阶段就挂了），
		// 先确认存在再删，避免无意义的 404 日志
		proj, err := d.client.GetPagesProject(ctx, d.opt.AccountID, name)
		if err != nil || proj == nil {
			continue
		}

		// 迁移自定义域名（如果有）
		if domain := d.findCustomDomain(ctx, name); domain != "" {
			_ = d.client.RemovePagesDomain(ctx, d.opt.AccountID, name, domain)
			if addErr := d.client.AddPagesDomain(ctx, d.opt.AccountID, finalName, domain); addErr != nil {
				d.warn(fmt.Sprintf(
					"清理旧项目 %s 前迁移域名失败（%s → %s）：%v\n"+
						"  → 请手动改绑，否则订阅地址会失效", name, domain, finalName, addErr))
				// 域名没迁成功就不删这个项目
				continue
			}
			d.log(fmt.Sprintf("· 已把域名 %s 从 %s 迁到 %s", domain, name, finalName))
		}

		if delErr := d.client.DeletePagesProject(ctx, d.opt.AccountID, name); delErr != nil {
			d.warn(fmt.Sprintf("清理被淘汰的项目 %s 失败：%v", name, delErr))
			continue
		}
		d.log(fmt.Sprintf("✅ 已清理被淘汰的项目：%s", name))
	}
}

// migrateAndCleanup 迁移自定义域名 + 删除旧项目。
//
// ## 顺序（真机实测得出，不能改）
//
//  1. 旧项目解绑域名   ← 必须！Pages 的同一域名同时只能挂一个项目
//  2. 新项目绑定域名
//  3. 删除旧项目
//
// 跳过第 1 步会报 `You have already added this custom domain`。
// 第 3 步必须在第 2 步之后，否则域名会在一段时间内指向不存在的项目。
func (d *Deployer) migrateAndCleanup(ctx context.Context, p deployAttemptParams, newName string) {
	oldName := p.oldProject
	// 只在确实换了项目时执行
	if oldName == "" || oldName == newName {
		return
	}

	// 1) 迁移自定义域名
	if p.customDomain != "" {
		domain := p.customDomain

		// 1a) 旧项目解绑（失败不阻断：可能本来就没绑在这上面）
		if err := d.client.RemovePagesDomain(ctx, d.opt.AccountID, oldName, domain); err == nil {
			d.log(fmt.Sprintf("· 已从旧项目 %s 解绑域名 %s", oldName, domain))
		}

		// 1b) 新项目绑定
		if err := d.client.AddPagesDomain(ctx, d.opt.AccountID, newName, domain); err != nil {
			d.warn(fmt.Sprintf(
				"自定义域名迁移失败（%s → %s）：%v\n"+
					"  → 请手动到 Cloudflare 控制台把该域名改绑到 %s，否则订阅地址会失效。",
				domain, newName, err, newName))
			// 迁移失败就别删旧项目 —— 旧项目还挂着用户唯一的访问入口
			return
		}
		d.log("✅ " + p.label + "自定义域名已迁移到新项目：" + domain)
	}

	// 2) 删除旧项目
	if err := d.client.DeletePagesProject(ctx, d.opt.AccountID, oldName); err != nil {
		d.warn(fmt.Sprintf("删除旧%s项目失败（%s）：%v", p.label, oldName, err))
		return
	}
	d.log(fmt.Sprintf("✅ 已删除被替换的旧%s项目：%s", p.label, oldName))
}

// waitForDeployment 轮询部署状态。
func (d *Deployer) waitForDeployment(ctx context.Context, project, label string) string {
	deadline := time.Now().Add(d.opt.WaitTimeout)
	for {
		if time.Now().After(deadline) {
			d.warn(label + "部署等待超时（" + project + "）")
			return ""
		}
		deps, err := d.client.ListPagesDeployments(ctx, d.opt.AccountID, project)
		if err == nil && len(deps) > 0 {
			// LatestStage 是对象，状态在 .status 里
			status := deps[0].LatestStage.Status
			switch status {
			case "success":
				return "success"
			case "failure", "canceled":
				return status
			}
		}
		time.Sleep(d.opt.WaitInterval)
	}
}

// randomSuffix 生成换名重试用的随机后缀（小写字母 + 数字）。
func randomSuffix(n int) string {
	return randomString(n, nameAlphabet)
}

func boolStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

// ---------- 随机生成 ----------

const nameAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomString(n int, alphabet string) string {
	out := make([]byte, 0, n)
	for i := 0; i < n; i++ {
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			// crypto/rand 失败极罕见，退化用时间戳字节
			out = append(out, alphabet[time.Now().UnixNano()%int64(len(alphabet))])
			continue
		}
		out = append(out, alphabet[idx.Int64()])
	}
	return string(out)
}

// RandomWorkerName 生成无特征字符的项目名（防风控）。
func RandomWorkerName() string {
	return randomString(8, nameAlphabet)
}

// RandomPanelPath 生成面板路径（**带前导斜杠**）。
//
// ## 为什么必须带斜杠
//
// 早期返回的是裸串（如 `g8ih0p7amfsh`），而 WS 路径是带斜杠的
// （`/fthiqeowoe`）。两者不一致带来三个问题：
//
//  1. 清单里存的值不规范，下次更新部署复用时会把裸串写进
//     `PANEL_PATH` 环境变量
//  2. 界面上显示「面板路径：g8ih0p7amfsh」，用户手动拼 URL 时
//     少打一个斜杠就打不开，容易误以为路径错了
//  3. 内核的 normalizePath() 虽然会自动补斜杠所以「碰巧能用」，
//     但那是内核对脏数据的容错，不该依赖它
//
// 现在统一带斜杠，与 RandomWSPath 保持一致。
func RandomPanelPath() string {
	return "/" + randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789")
}

// RandomWSPath 生成 WS 路径（带前导斜杠）。
func RandomWSPath() string {
	return "/" + randomString(10, "abcdefghijklmnopqrstuvwxyz")
}

// RandomPassword 生成面板 / Trojan 密码。
func RandomPassword() string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	return randomString(24, chars)
}

// RandomUUID 生成 v4 UUID。
func RandomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> uint(i))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
