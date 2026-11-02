// Workers 数据面部署原语（Go 版，**不含自定义域名托管**）。
//
// 对应 packages/cli/src/deploy/workers-deploy.ts —— 语义必须与 CLI 完全一致。
//
// ## 设计取舍（2026-10-31 重构）
//
// 早期版本试图替用户绑定 Worker 自定义域名，结果踩了一串平台限制：
//
//   - Pages 绑过自定义域名后，解绑**不会**删掉那条 CNAME；
//   - Worker 自定义域名要求主机名**没有任何现存记录**，否则 409 / 100117；
//   - 删记录要 Zone / DNS 写权限，而账号级 Token（`cfat_`）在很多账号下
//     根本拿不到这一项 —— 真机两个令牌读 DNS 都是 403。
//
// 于是「工具替用户绑域名」这条路对相当一部分用户走不通。
//
// 现在：**工具只把 Worker 部署到它的生产域名**（`*.workers.dev`），
// 自定义域名由用户在控制台自行绑定，然后到面板「设置 → 数据面域名」填一次
// （`CONFIG.subDomain` 优先级高于 `DATA_HOST` 环境变量）。
package deploy

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// workersCompatDate 是 Worker 的 compatibility_date。
//
// 固定值而不是取当天：产物必须可复现，同一份代码在任意机器上行为一致。
const workersCompatDate = "2026-10-01"

// workersPermHint 是 Workers 模式唯一额外需要的权限。
//
// 不再需要 Workers Routes / DNS —— 工具不碰自定义域名。
var workersPermHint = struct {
	scripts string
}{
	scripts: "Token 中添加 Account / Workers Scripts / Edit",
}

// isPermissionErr 判断是否是 401/403 类权限错误。
func isPermissionErr(err error) bool {
	var apiErr *cfapi.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status == 401 || apiErr.Status == 403
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "403") || strings.Contains(msg, "401") ||
		strings.Contains(msg, "authentication error") || strings.Contains(msg, "permission")
}

// resolveNodeHost 决定订阅里的**节点域名**。
//
// 用户填了就用它（工具只把它写进 DATA_HOST，不绑定），否则退回 workers.dev。
func resolveNodeHost(dataHost, devHost string) string {
	if host := strings.TrimSpace(dataHost); host != "" {
		return host
	}
	return devHost
}

// workersDevHost 计算 Worker 的生产域名。
// WorkersDevHost 拼出 Worker 的 workers.dev 生产域名。
//
// 账号没注册 workers.dev 子域时退回 `<name>.workers.dev` ——
// 否则会出现 `name..workers.dev` 这种畸形域名。
//
// 导出给服务端的「检查部署状态 / 自动识别」用：
// 那里也要能算出同一个兜底域名（两端必须一致）。
func WorkersDevHost(name, subdomain string) string {
	return workersDevHost(name, subdomain)
}

func workersDevHost(name, subdomain string) string {
	sub := strings.TrimSpace(subdomain)
	if sub == "" {
		return name + ".workers.dev"
	}
	return name + "." + sub + ".workers.dev"
}

// workersBindings 构造脚本绑定（KV + 明文变量）。
//
// 与 CLI 的 workersBindings 一一对应：少一个变量，数据面就会回落到默认值
// （UUID / WS 路径不匹配 → 客户端全连不上）。
func (d *Deployer) workersBindings(eff effective) []cfapi.WorkerBinding {
	out := []cfapi.WorkerBinding{
		{"type": "kv_namespace", "name": "KV", "namespace_id": d.opt.KVNamespaceID},
		{"type": "plain_text", "name": "UUID", "text": eff.uuid},
		{"type": "plain_text", "name": "TROJAN_PASSWORD", "text": eff.trojanPassword},
		{"type": "plain_text", "name": "WS_PATH", "text": eff.wsPath},
		{"type": "plain_text", "name": "PATH", "text": eff.wsPath},
		{"type": "plain_text", "name": "ENABLE_TROJAN", "text": boolStr(d.opt.EnableTrojan)},
		{"type": "plain_text", "name": "ENABLE_XHTTP", "text": boolStr(d.opt.EnableXHTTP)},
	}
	if d.opt.ResolvePreferred != nil {
		out = append(out, cfapi.WorkerBinding{
			"type": "plain_text", "name": "RESOLVE_PREFERRED", "text": boolStr(*d.opt.ResolvePreferred),
		})
	}
	return out
}

// preflightWorkersDataPlane 部署前权限预检（只读，不创建任何资源）。
//
// 只检查 Workers 脚本权限 —— 不再绑自定义域名，Routes / DNS 都不需要。
func (d *Deployer) preflightWorkersDataPlane(ctx context.Context) error {
	d.log("· 预检 Workers 数据面所需权限…")

	if _, err := d.client.ListScripts(ctx, d.opt.AccountID); err != nil {
		if isPermissionErr(err) {
			return fmt.Errorf("Token 缺少「Workers 脚本」权限（%v）。\n"+
				"  → %s\n"+
				"  → Workers 模式比 Pages 模式多这一项权限；不想加就把数据面部署模式改回 Pages。",
				err, workersPermHint.scripts)
		}
		d.warn(fmt.Sprintf("无法读取 Workers 脚本列表：%v", err))
	} else {
		d.log("  · Workers 脚本权限正常")
	}

	sub, err := d.client.GetWorkersSubdomain(ctx, d.opt.AccountID)
	switch {
	case err != nil:
		// 读不到不影响部署，后面按 <name>.workers.dev 兜底
	case sub == "":
		d.warn("该账号还没有 workers.dev 子域。\n" +
			"  → 请到 Cloudflare 控制台 → Workers 和 Pages → 设置一次子域，否则节点域名不可用。")
	default:
		d.log("  · workers.dev 子域：" + sub)
	}
	return nil
}

// deployWorkersDataPlane 上传脚本 → 调整 workers.dev 链接 → 返回节点域名。
//
// ## 节点域名从哪来
//
// 控制面的 `DATA_HOST` 决定订阅里节点的 sni/host，**必须**是用户能连通的域名。
// `*.workers.dev` 在很多网络下直连不可访问，所以：
//
//   - 用户填了自定义域名 → 用它做节点域名（工具**不绑定**，只提示去「域」标签页添加）；
//   - 没填 → 用 workers.dev 兜底，并显著告警。
//
// ## workers.dev 链接必须关掉（有自定义域名时）
//
// 真机事故（2026-11-02）：数据面绑了自定义域名后，
// workers.dev 的**生产链接与预览链接都要关掉**，否则订阅节点全部 -1。
//
// 判定依据有两个（任一成立就关）：
//   - 用户在部署页填了「数据面域名」→ 他的意图就是走自定义域名；
//   - 这个 Worker 确实绑了自定义域名（读 /workers/domains）。
//
// 没绑定自定义域名时反而要**开着** —— 否则连一个能用的入口都没有。
func (d *Deployer) deployWorkersDataPlane(ctx context.Context, name string, eff effective) (string, error) {
	d.log("· 上传 Workers 数据面脚本 " + name)
	if err := d.client.UploadWorkerScript(
		ctx, d.opt.AccountID, name, d.opt.DataScript, d.workersBindings(eff), workersCompatDate,
	); err != nil {
		return "", err
	}

	sub, _ := d.client.GetWorkersSubdomain(ctx, d.opt.AccountID)
	devHost := workersDevHost(name, sub)
	dataHost := strings.TrimSpace(d.opt.DataHost)

	// 这个 Worker 已经绑了哪些自定义域名？
	boundCustom := ""
	if domains, err := d.client.ListWorkerDomains(ctx, d.opt.AccountID); err == nil {
		for _, dm := range domains {
			if dm.Service == name && dm.Hostname != "" {
				boundCustom = dm.Hostname
				break
			}
		}
	}

	// 有自定义域名（用户填了 / 已经绑了）→ 关掉 workers.dev 的生产与预览链接。
	if dataHost != "" || boundCustom != "" {
		if err := d.client.PutScriptSubdomain(ctx, d.opt.AccountID, name, false, false); err != nil {
			d.warn(fmt.Sprintf("关闭 workers.dev 链接失败：%v\n"+
				"  → 到控制台 → Workers → 你的脚本 → 设置 → 域和路由，把「生产」与「预览」都关掉，\n"+
				"    否则节点会全部连不上（真机事故 2026-11-02）。", err))
		} else {
			d.log("✅ 已关闭 workers.dev 的生产链接与预览链接（节点走自定义域名）")
		}
	} else {
		// 上传成功后 workers.dev 路由默认关闭，必须显式开启，
		// 否则 https://<name>.<sub>.workers.dev 一直返回「There is nothing here yet」。
		if err := d.client.PutScriptSubdomain(ctx, d.opt.AccountID, name, true, false); err != nil {
			d.warn(fmt.Sprintf("开启 workers.dev 路由失败：%v\n"+
				"  → 到控制台 → Workers → 你的脚本 → 设置 → 域和路由 里手动开启即可。", err))
		}
	}

	// 节点域名：用户填的优先；没填但 Worker 绑了自定义域名 → 用绑定的那个。
	host := resolveNodeHost(dataHost, devHost)
	if dataHost == "" && boundCustom != "" {
		host = boundCustom
	}

	// ⚠️ 写之前先校验域名没有"串号"（真机事故 2026-11-02 的最后一道防线）。
	if dataHost != "" {
		if err := d.checkNodeHostOwnership(ctx, name, dataHost); err != nil {
			return "", err
		}
	}

	if dataHost != "" {
		d.warn(fmt.Sprintf(
			"控制面的节点域名已设为 %s（写入 DATA_HOST）。\n"+
				"  → 工具不会替你绑定域名，请到 Cloudflare 控制台 → Workers 和 Pages → %s → 「域」标签页 → 添加自定义域名，填 %s\n"+
				"  → 没绑定之前，这个域名的流量到不了 Worker。",
			dataHost, name, dataHost))
	} else if boundCustom != "" {
		d.warn(fmt.Sprintf(
			"控制面的节点域名已设为 %s（数据面已绑定的自定义域名，写入 DATA_HOST）。\n"+
				"  → workers.dev 的生产与预览链接已关闭，节点只走这个自定义域名。",
			boundCustom))
	} else {
		d.warn(fmt.Sprintf(
			"未填写节点域名，控制面的 DATA_HOST 用的是 %s。\n"+
				"  → *.workers.dev 域名在很多网络下直连不可访问，节点会连不上；\n"+
				"  → 请到 Workers 和 Pages → %s → 「域」标签页添加自定义域名，然后回面板「设置 → 数据面域名」填上它。",
			devHost, name))
	}

	return host, nil
}

// checkNodeHostOwnership 校验填写的节点域名没有"串号"。
//
// ## 为什么需要这道防线
//
// 真机事故（2026-11-02）：切换账户后「数据面域名」输入框残留了上一个账号的值，
// 更新部署时把它写进了控制面 DATA_HOST → 订阅节点的 sni/host 指向别的域名
// → **节点全部 -1**。
//
// 界面侧已经修好（切账户清空输入框），但**部署是写操作**，
// 这里再加一道服务端校验：写之前先确认这个域名确实是"给数据面用的"。
//
// ## 拦哪些、放行哪些
//
//   - 是**控制面**的域名 → 拦（控制面不转发代理流量，节点必然连不上）
//   - 是账号里**别的 Worker** 的域名 → 拦（串到别的服务上去了）
//   - 还没绑（用户准备部署完再去控制台绑） → **放行**（首次部署的正常流程）
func (d *Deployer) checkNodeHostOwnership(ctx context.Context, dataPlaneName, host string) error {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil
	}
	// 0) 与数据面**已绑定**的域名必须一致（这条正好拦下真机事故）。
	//
	// 真机事故里：数据面早就绑了 data.shijingtian.dpdns.org，
	// 而输入框里残留的是另一个域名 → 写进 DATA_HOST → 节点全部 -1。
	//
	// 数据面**还没绑过**任何域名时放行 —— 那是首次部署的正常流程
	// （工具不绑域名，用户部署完自己去控制台绑）。
	if bound, err := d.boundCustomDomain(ctx, dataPlaneName); err == nil && bound != "" && bound != host {
		return fmt.Errorf(
			"节点域名填的是 %s，但数据面 Worker 已绑定的自定义域名是 %s —— 两者必须一致\n"+
				"  → 填错的域名会被写进控制面 DATA_HOST，订阅节点会全部连不上；\n"+
				"  → 若要换域名，请先到控制台解绑旧的、再绑定新的，然后填新的。", host, bound)
	}
	// 1) 控制面的自定义域名
	if d.result.Control.Name != "" {
		if p, err := d.client.GetPagesProject(ctx, d.opt.AccountID, d.result.Control.Name); err == nil && p != nil {
			for _, dm := range p.Domains {
				if strings.EqualFold(strings.TrimSpace(dm), host) {
					return fmt.Errorf(
						"节点域名 %s 是**控制面**的域名，不能用作数据面节点域名（控制面不转发代理流量，节点会全部连不上）"+
							"\n  → 请改成数据面 Worker 的域名；确认是否切换过账户导致输入框残留。", host)
				}
			}
		}
	}
	// 2) 账号里别的 Worker 的域名
	if domains, err := d.client.ListWorkerDomains(ctx, d.opt.AccountID); err == nil {
		for _, dm := range domains {
			if dm.Service != dataPlaneName && strings.EqualFold(strings.TrimSpace(dm.Hostname), host) {
				return fmt.Errorf(
					"节点域名 %s 已绑定在账号里的另一个 Worker（%s）上，不能同时用作数据面节点域名"+
						"\n  → 请改成数据面 Worker 自己的域名；确认是否切换过账户导致输入框残留。", host, dm.Service)
			}
		}
	}
	return nil
}

// boundCustomDomain 返回某个 Worker 已绑定的自定义域名（没绑过则空串）。
func (d *Deployer) boundCustomDomain(ctx context.Context, service string) (string, error) {
	domains, err := d.client.ListWorkerDomains(ctx, d.opt.AccountID)
	if err != nil {
		return "", err
	}
	for _, dm := range domains {
		if dm.Service == service && dm.Hostname != "" {
			return strings.ToLower(strings.TrimSpace(dm.Hostname)), nil
		}
	}
	return "", nil
}

// deleteWorkersDataPlane 删除 Workers 数据面（脚本一删，它上面的自定义域名绑定也随之释放）。
func (d *Deployer) deleteWorkersDataPlane(ctx context.Context, name string) error {
	if err := d.client.DeleteWorkerScript(ctx, d.opt.AccountID, name); err != nil {
		return err
	}
	d.log("✅ 已删除旧 Workers 数据面：" + name)
	return nil
}

// detachAllPagesDomains 解绑 Pages 项目上的全部自定义域名。
//
// ⚠️ **删除项目前必须做**（真机 8000028）：
//
//	To delete your project, you must first delete all custom domains
//	associated with your project.（HTTP 400，code 8000028）
//
// 原来的 8000119 换名流程里本来就有这一步（先解绑再删旧项目），换形态时漏了。
func (d *Deployer) detachAllPagesDomains(ctx context.Context, project string) []string {
	domains, err := d.client.ListPagesDomains(ctx, d.opt.AccountID, project)
	if err != nil {
		return nil
	}
	var removed []string
	for _, item := range domains {
		name := item.Name
		if name == "" || strings.HasSuffix(name, ".pages.dev") {
			continue
		}
		if rerr := d.client.RemovePagesDomain(ctx, d.opt.AccountID, project, name); rerr != nil {
			d.warn(fmt.Sprintf("解绑 %s 的域名 %s 失败：%v\n"+
				"  → 需要先到 Cloudflare 控制台手动删除该项目的自定义域名，否则项目删不掉。",
				project, name, rerr))
			continue
		}
		removed = append(removed, name)
		d.log(fmt.Sprintf("· 已从旧 Pages 数据面 %s 解绑域名 %s", project, name))
	}
	return removed
}
