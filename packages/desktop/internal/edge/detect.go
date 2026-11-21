// 盲中继 / 云监测台「检测部署状态」（桌面版实现）。
//
// 与 CLI `cfpilot edge status`（packages/cli/src/edge/detect.ts）同源：
// 识别规则、字段语义、warning 文案要逐条对齐（改一处必须同步另一处）。
//
// ## 只读约束
//
// 本文件只调用 GET 类接口（外加对 /health、/auth/status 的只读探测），
// 不部署、不写 KV / DNS / Worker —— 「检测」永远不能改变线上状态。
//
// ## 为什么按绑定特征识别
//
// 盲中继是「独立资源」，KV 里没有清单键可读，Worker 名也可能被用户改过。
// 所以以脚本 settings 的绑定为判据：
//  1. 存在名为 MONITOR_TOKEN 的绑定（plain_text 可读值；secret_text 算存在但值不可读）；
//  2. 且至少满足其一：durable_object_namespace 且 class_name = MeshRoom、
//     或 d1 绑定且 name = DB。
//
// 名字像盲中继的脚本优先探测（总量封顶，避免账号大时刷请求）。
package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// detectDoClass 是盲中继 Worker 的 Durable Object 类名（与部署侧一致）。
const detectDoClass = "MeshRoom"

// maxSettingsProbes 是单次检测最多读取多少个脚本的 settings。
const maxSettingsProbes = 12

// initialProbeTimeout 是 Worker 状态探测的单次请求超时。
const initialProbeTimeout = 6 * time.Second

// Limits 是部署时的限速 / 容量绑定值（缺省为空串，表示用 Worker 内置默认）。
type Limits struct {
	WindowMs   string `json:"windowMs"`
	MaxBytes   string `json:"maxBytes"`
	MaxPackets string `json:"maxPackets"`
	MaxPeers   string `json:"maxPeers"`
}

// Instance 是一个已部署的盲中继实例（字段与 CLI EdgeRelayInstance 对齐）。
type Instance struct {
	WorkerName       string   `json:"workerName"`
	Domain           string   `json:"domain"`
	WorkerURL        string   `json:"workerUrl"`
	WssEndpoint      string   `json:"wssEndpoint"`
	ZoneID           string   `json:"zoneId"`
	ZoneName         string   `json:"zoneName"`
	DashboardProject string   `json:"dashboardProject"`
	DashboardURL     string   `json:"dashboardUrl"`
	DashboardReady   bool     `json:"dashboardReady"`
	D1Name           string   `json:"d1Name"`
	D1UUID           string   `json:"d1Uuid"`
	DoClass          string   `json:"doClass"`
	MonitorToken     string   `json:"monitorToken"`
	Limits           Limits   `json:"limits"`
	Reachable        bool     `json:"reachable"`
	PasswordSet      bool     `json:"passwordSet"`
	Warnings         []string `json:"warnings"`
}

// DetectOptions 控制检测行为。
type DetectOptions struct {
	// Probe 为 true 时做域名可达性探测（默认由调用方决定：true）。
	Probe bool
	// Prober 是测试注入点；nil 时探测根页面、/health 与 /auth/status。
	Prober func(ctx context.Context, baseURL string) (reachable, dashboardReady, passwordSet bool, err error)
}

func (o DetectOptions) prober() func(ctx context.Context, baseURL string) (bool, bool, bool, error) {
	if o.Prober != nil {
		return o.Prober
	}
	return probeRelayHTTP
}

/* ------------------------------------------------------------------ */
/* 纯函数：识别与取值（单测直接覆盖）                                   */
/* ------------------------------------------------------------------ */

// bindingString 读取绑定里的字符串字段。
func bindingString(b cfapi.WorkerBinding, key string) string {
	if v, ok := b[key].(string); ok {
		return v
	}
	return ""
}

// isEdgeRelayBindings 判断一组绑定是否属于盲中继 Worker。
func isEdgeRelayBindings(bindings []cfapi.WorkerBinding) bool {
	hasToken := false
	hasRoom := false
	for _, b := range bindings {
		typ := bindingString(b, "type")
		name := bindingString(b, "name")
		if name == "MONITOR_TOKEN" && (typ == "plain_text" || typ == "secret_text") {
			hasToken = true
		}
		if typ == "durable_object_namespace" &&
			(name == "MESH_ROOM" || bindingString(b, "class_name") == detectDoClass) {
			hasRoom = true
		}
		if typ == "d1" && name == "DB" {
			hasRoom = true
		}
	}
	return hasToken && hasRoom
}

// readPlainText 读取 plain_text 绑定值（不存在或为 secret 时返回空串）。
func readPlainText(bindings []cfapi.WorkerBinding, name string) string {
	for _, b := range bindings {
		if bindingString(b, "type") == "plain_text" && bindingString(b, "name") == name {
			return bindingString(b, "text")
		}
	}
	return ""
}

// readD1BindingID 读取 DB 绑定指向的 D1 UUID。
func readD1BindingID(bindings []cfapi.WorkerBinding) string {
	for _, b := range bindings {
		if bindingString(b, "type") == "d1" && bindingString(b, "name") == "DB" {
			return bindingString(b, "id")
		}
	}
	return ""
}

var relayNameRe = regexp.MustCompile(`(?i)(edge[-_]?relay|mobihop|relay)`)
var dashboardHTMLRe = regexp.MustCompile(`(?i)<!doctype\s+html|<html\b`)

// looksLikeRelayScript 判断名字像不像盲中继脚本（只用于探测优先级）。
func looksLikeRelayScript(name string) bool { return relayNameRe.MatchString(name) }

// rankScriptNames 排序探测顺序：指定名字最前，其次像盲中继的，最后其余；同档按名字排序保证稳定。
func rankScriptNames(names []string, wanted string) []string {
	out := append([]string(nil), names...)
	score := func(n string) int {
		switch {
		case wanted != "" && n == wanted:
			return 0
		case looksLikeRelayScript(n):
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		si, sj := score(out[i]), score(out[j])
		if si != sj {
			return si < sj
		}
		return out[i] < out[j]
	})
	return out
}

// pickWorkerDomain 选脚本的自定义域名（启用优先，其次名字排序保证稳定）。
func pickWorkerDomain(domains []cfapi.WorkerDomain, workerName string) string {
	hits := make([]cfapi.WorkerDomain, 0, len(domains))
	for _, d := range domains {
		if d.Service == workerName && strings.TrimSpace(d.Hostname) != "" {
			hits = append(hits, d)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		ei, ej := 1, 1
		if hits[i].Enabled {
			ei = 0
		}
		if hits[j].Enabled {
			ej = 0
		}
		if ei != ej {
			return ei < ej
		}
		return hits[i].Hostname < hits[j].Hostname
	})
	if len(hits) == 0 {
		return ""
	}
	return hits[0].Hostname
}

// pickDashboardProject 找监测面板 Pages 项目：先精确 `<worker>-dashboard`，再按命名兜底。
//
// 兜底只在「恰好一个 dashboard/monitor 项目」时生效，避免误选；
// 返回 guessed=true 时调用方要给出提示。
func pickDashboardProject(projects []cfapi.PagesProject, workerName string) (project string, guessed bool) {
	exact := workerName + "-dashboard"
	for _, p := range projects {
		if p.Name == exact {
			return p.Name, false
		}
	}
	fuzzy := make([]string, 0, 1)
	for _, p := range projects {
		if strings.Contains(strings.ToLower(p.Name), "dashboard") ||
			strings.Contains(strings.ToLower(p.Name), "monitor") {
			fuzzy = append(fuzzy, p.Name)
		}
	}
	if len(fuzzy) == 1 {
		return fuzzy[0], true
	}
	return "", false
}

// matchZoneByDomain 按最长后缀匹配域名所属 zone（与 server 的 matchZoneID 同语义）。
//
// 不在 server 包里复用：edge 包不依赖 server（避免反向依赖），逻辑很短且有单测。
func matchZoneByDomain(domain string, zones []cfapi.Zone) *cfapi.Zone {
	d := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	if d == "" {
		return nil
	}
	var best *cfapi.Zone
	for i := range zones {
		name := strings.ToLower(strings.TrimSuffix(zones[i].Name, "."))
		if name == "" {
			continue
		}
		if d == name || strings.HasSuffix(d, "."+name) {
			if best == nil || len(name) > len(best.Name) {
				best = &zones[i]
			}
		}
	}
	return best
}

/* ------------------------------------------------------------------ */
/* 默认可达性探测                                                       */
/* ------------------------------------------------------------------ */

// probeRelayHTTP 探测 Worker 健康状态、根路径监测台 HTML 与鉴权状态。
//
// fail-soft：网络不通只代表「本机访问不到」，不代表实例不存在，
// 调用方据此给 warning 而不是判失败。
func probeRelayHTTP(ctx context.Context, baseURL string) (reachable, dashboardReady, passwordSet bool, err error) {
	client := &http.Client{Timeout: initialProbeTimeout}
	healthReq, rerr := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/health", nil)
	if rerr != nil {
		return false, false, false, rerr
	}
	res, herr := client.Do(healthReq)
	if herr != nil {
		return false, false, false, herr
	}
	_ = res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return false, false, false, fmt.Errorf("/health 返回 HTTP %d", res.StatusCode)
	}
	reachable = true

	rootReq, rerr := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/", nil)
	if rerr == nil {
		rootRes, rootErr := client.Do(rootReq)
		if rootErr == nil {
			contentType := rootRes.Header.Get("Content-Type")
			if rootRes.StatusCode >= 200 && rootRes.StatusCode < 300 && strings.Contains(strings.ToLower(contentType), "text/html") {
				page, _ := io.ReadAll(io.LimitReader(rootRes.Body, 1024*1024))
				dashboardReady = dashboardHTMLRe.Match(page)
			}
			_ = rootRes.Body.Close()
		}
	}

	statusReq, rerr := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/auth/status", nil)
	if rerr != nil {
		return reachable, dashboardReady, false, nil
	}
	res2, serr := client.Do(statusReq)
	if serr != nil {
		return reachable, dashboardReady, false, nil
	}
	defer func() { _ = res2.Body.Close() }()
	if res2.StatusCode >= 200 && res2.StatusCode < 300 {
		var body struct {
			SetupRequired bool `json:"setupRequired"`
		}
		if json.NewDecoder(res2.Body).Decode(&body) == nil {
			passwordSet = !body.SetupRequired
		}
	}
	return reachable, dashboardReady, passwordSet, nil
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

// Detect 检测账号下的盲中继实例（只读）。
//
// 返回的 warnings 是「账号级」提示（列表接口失败、探测数量截断等）；
// 每个实例自己的提示在 Instance.Warnings 里。
func Detect(ctx context.Context, client *cfapi.Client, accountID string, opt DetectOptions) ([]Instance, []string, error) {
	warnings := []string{}
	doProbe := opt.Probe
	prober := opt.prober()

	// ---- 1. 脚本列表（权限不足时直接失败：这时「没检测到」是假象） ----
	names, err := client.ListScripts(ctx, accountID)
	if err != nil {
		return nil, warnings, fmt.Errorf(
			"读取 Worker 脚本列表失败（需要 Workers Scripts / Read 权限）：%w", err)
	}

	// ---- 2. 账号级资源：任一失败只降级为 warning ----
	domains, derr := client.ListWorkerDomains(ctx, accountID)
	if derr != nil {
		warnings = append(warnings, "读取 Worker 域名绑定失败："+derr.Error())
		domains = nil
	}
	d1List, qerr := client.ListD1Databases(ctx, accountID)
	if qerr != nil {
		warnings = append(warnings, "读取 D1 数据库列表失败："+qerr.Error())
		d1List = nil
	}
	projects, perr := client.ListPagesProjects(ctx, accountID)
	if perr != nil {
		warnings = append(warnings, "读取 Pages 项目列表失败："+perr.Error())
		projects = nil
	}
	zones, zerr := client.ListZones(ctx)
	if zerr != nil {
		warnings = append(warnings, "读取 Zone 列表失败："+zerr.Error())
		zones = nil
	}
	workersSubdomain, _ := client.GetWorkersSubdomain(ctx, accountID)

	// ---- 3. 逐个脚本读 settings，按绑定特征识别 ----
	ranked := rankScriptNames(names, "")
	probeNames := ranked
	if len(probeNames) > maxSettingsProbes {
		warnings = append(warnings, fmt.Sprintf(
			"账号下有 %d 个 Worker 脚本，只检查了前 %d 个（优先名字像盲中继的）",
			len(probeNames), maxSettingsProbes))
		probeNames = probeNames[:maxSettingsProbes]
	}

	instances := make([]Instance, 0, 1)
	for _, name := range probeNames {
		bindings, berr := client.GetWorkerScriptSettings(ctx, accountID, name)
		if berr != nil {
			// 单个脚本读不到 settings（权限 / 竞态删除）不影响其它实例
			continue
		}
		if !isEdgeRelayBindings(bindings) {
			continue
		}

		ins := Instance{
			WorkerName: name,
			DoClass:    detectDoClass,
			Warnings:   []string{},
			Limits: Limits{
				WindowMs:   readPlainText(bindings, "WINDOW_MS"),
				MaxBytes:   readPlainText(bindings, "MAX_BYTES_PER_WINDOW"),
				MaxPackets: readPlainText(bindings, "MAX_PACKETS_PER_WINDOW"),
				MaxPeers:   readPlainText(bindings, "MAX_PEERS_PER_ROOM"),
			},
		}

		ins.Domain = pickWorkerDomain(domains, name)
		if ins.Domain == "" {
			ins.Warnings = append(ins.Warnings,
				"未绑定自定义域名：workers.dev 生产链路被阻断，节点连不上")
		}
		if zone := matchZoneByDomain(ins.Domain, zones); zone != nil {
			ins.ZoneID = zone.ID
			ins.ZoneName = zone.Name
		}
		if project, _ := pickDashboardProject(projects, name); project != "" {
			ins.DashboardProject = project
		}

		d1ID := readD1BindingID(bindings)
		for _, db := range d1List {
			if d1ID != "" && db.UUID == d1ID {
				ins.D1Name, ins.D1UUID = db.Name, db.UUID
				break
			}
		}
		if ins.D1Name == "" {
			for _, db := range d1List {
				if db.Name == name+"-monitor" {
					ins.D1Name, ins.D1UUID = db.Name, db.UUID
					break
				}
			}
		}
		if ins.D1Name == "" {
			ins.Warnings = append(ins.Warnings, "没找到监测数据库（D1），监测台可能不可用")
		}

		ins.MonitorToken = readPlainText(bindings, "MONITOR_TOKEN")
		if ins.MonitorToken == "" {
			ins.Warnings = append(ins.Warnings,
				"上报令牌以 secret 存储或已被移除，无法回填 —— 请到 Worker 端核对 MONITOR_TOKEN")
		}

		if ins.Domain != "" {
			ins.WorkerURL = "https://" + ins.Domain
			ins.WssEndpoint = "wss://" + ins.Domain + "/mesh/<network_hash>?peer_id=<16hex>"
		} else if workersSubdomain != "" {
			ins.WorkerURL = "https://" + name + "." + workersSubdomain + ".workers.dev"
		}

		if doProbe && ins.Domain != "" {
			reachable, dashboardReady, passwordSet, prowErr := prober(ctx, ins.WorkerURL)
			ins.Reachable = reachable
			ins.DashboardReady = dashboardReady
			ins.PasswordSet = passwordSet
			if prowErr != nil {
				ins.Warnings = append(ins.Warnings, "可达性探测失败："+prowErr.Error())
			} else if !reachable {
				ins.Warnings = append(ins.Warnings, "本机访问不到该域名（可能需要代理），配置仍可回填")
			} else if !dashboardReady {
				ins.Warnings = append(ins.Warnings, "监测台未部署：盲中继根路径尚未返回监测页面")
			}
		}
		if ins.DashboardReady {
			ins.DashboardURL = ins.WorkerURL
		}

		instances = append(instances, ins)
	}

	sort.SliceStable(instances, func(i, j int) bool {
		return instances[i].WorkerName < instances[j].WorkerName
	})
	return instances, warnings, nil
}
