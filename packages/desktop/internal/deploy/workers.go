// Workers 数据面部署原语（Go 版）。
//
// 对应 packages/cli/src/deploy/workers-deploy.ts —— **语义必须与 CLI 完全一致**，
// 两端差异会让「桌面版部署出来的实例」与「CLI 部署出来的实例」行为不同，
// 而用户完全看不出区别。
//
// ## 三条硬约束
//
//  1. 控制面永远留在 Pages（面板 + 订阅 + 探针不含出站 TCP）。
//  2. `*.workers.dev` 生产域名会被阻断 → 节点域名必须用自定义域名；
//     没给域名时仍可部署，但必须告警。
//  3. 自定义域名必须属于**本账号的 zone**；绑定返回值只代表「已受理」，
//     可达性要再探一次（证书签发要 1~3 分钟）。
package deploy

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// workersCompatDate 是 Worker 的 compatibility_date。
//
// 固定值而不是取当天：产物必须可复现，同一份代码在任意机器上行为一致。
// 改它等于改运行时语义，必须单独评估。
const workersCompatDate = "2026-10-01"

// workersBindings 构造脚本绑定（KV + 明文变量）。
//
// 与 CLI 的 workersBindings 一一对应：
// 少一个变量，数据面就会回落到默认值（UUID / WS 路径不匹配 → 客户端全连不上）。
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

// resolveZoneForHost 找出 hostname 归属的 zone（最长后缀匹配）。
//
// 不能只按 zone 顶点名精确查：传 w1.example.com 查不到 example.com，
// 于是「账号里明明有这个域名」也会被误判成没有。
func (d *Deployer) resolveZoneForHost(ctx context.Context, hostname string) (*cfapi.Zone, error) {
	zones, err := d.client.ListZones(ctx)
	if err != nil {
		return nil, err
	}
	host := strings.ToLower(strings.TrimSpace(hostname))
	var best *cfapi.Zone
	for i := range zones {
		z := &zones[i]
		name := strings.ToLower(z.Name)
		if host != name && !strings.HasSuffix(host, "."+name) {
			continue
		}
		if best == nil || len(name) > len(best.Name) {
			best = z
		}
	}
	return best, nil
}

// findWorkerDomain 找出某个脚本已绑定的自定义域名。
func (d *Deployer) findWorkerDomain(ctx context.Context, service string) *cfapi.WorkerDomain {
	domains, err := d.client.ListWorkerDomains(ctx, d.opt.AccountID)
	if err != nil {
		return nil
	}
	for i := range domains {
		if domains[i].Service == service {
			return &domains[i]
		}
	}
	return nil
}

// detachWorkerHostname 解除脚本上的自定义域名绑定，返回被解绑的域名。
func (d *Deployer) detachWorkerHostname(ctx context.Context, service string) string {
	domain := d.findWorkerDomain(ctx, service)
	if domain == nil {
		return ""
	}
	if err := d.client.DeleteWorkerDomain(ctx, d.opt.AccountID, domain.ID); err != nil {
		return ""
	}
	return domain.Hostname
}

// probeHost 轮询确认域名真的能访问（拿到任意 HTTP 响应即算通）。
//
// 失败**不阻断部署**：证书签发有延迟，用户稍后自己会看到；
// 但必须告警，否则用户拿着一个连不上的节点排查半天。
func probeHost(host string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 10 * time.Second}
	for {
		res, err := client.Get("https://" + host + "/")
		if err == nil {
			_ = res.Body.Close()
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Second)
	}
}

// deployWorkersDataPlane 上传脚本 → 绑域名（或开 workers.dev）→ 校验可达。
//
// 返回客户端要连的域名与绑定的自定义域名（没绑则空串）。
func (d *Deployer) deployWorkersDataPlane(
	ctx context.Context, name string, eff effective, hostname string,
) (host string, customDomain string, err error) {
	d.log("· 上传 Workers 数据面脚本 " + name)
	if err := d.client.UploadWorkerScript(
		ctx, d.opt.AccountID, name, d.opt.DataScript, d.workersBindings(eff), workersCompatDate,
	); err != nil {
		return "", "", err
	}

	if hostname != "" {
		zone, zerr := d.resolveZoneForHost(ctx, hostname)
		if zerr != nil {
			return "", "", zerr
		}
		if zone == nil {
			return "", "", fmt.Errorf(
				"域名 %s 不在本账号的任何 zone 下，无法绑定为 Worker 自定义域名。"+
					"请确认该域名的 DNS 托管在这个 Cloudflare 账号里", hostname)
		}
		if _, aerr := d.client.AttachWorkerDomain(ctx, d.opt.AccountID, hostname, name, zone.ID); aerr != nil {
			return "", "", aerr
		}
		d.log("✅ 已绑定自定义域名 " + hostname)
		if !probeHost(hostname, 90*time.Second) {
			d.warn(fmt.Sprintf(
				"自定义域名 %s 在 90 秒内仍未返回响应（证书签发通常需要 1~3 分钟）。\n"+
					"  → 稍等片刻用浏览器打开该域名确认；若长时间不可用，请到 Cloudflare 控制台检查\n"+
					"    Workers → 你的脚本 → 设置 → 域和路由 里的自定义域名状态。", hostname))
		}
		return hostname, hostname, nil
	}

	// 没有自定义域名 → 回落到 workers.dev（能部署，但多数网络下直连不可用）
	_ = d.client.PutScriptSubdomain(ctx, d.opt.AccountID, name, true)
	sub, _ := d.client.GetWorkersSubdomain(ctx, d.opt.AccountID)
	host = name + ".workers.dev"
	if sub != "" {
		host = name + "." + sub + ".workers.dev"
	}
	d.warn(fmt.Sprintf(
		"未配置自定义域名，数据面使用 %s。\n"+
			"  → *.workers.dev 域名直连无法访问，请登录 cloudflare 控制台配置自定义域名，"+
			"否则客户端节点会全部连不上。", host))
	return host, "", nil
}

// deleteWorkersDataPlane 删除 Workers 数据面（先解绑域名，再删脚本）。
func (d *Deployer) deleteWorkersDataPlane(ctx context.Context, name string) error {
	if host := d.detachWorkerHostname(ctx, name); host != "" {
		d.log("· 已解绑旧数据面域名 " + host)
	}
	if err := d.client.DeleteWorkerScript(ctx, d.opt.AccountID, name); err != nil {
		return err
	}
	d.log("✅ 已删除旧 Workers 数据面：" + name)
	return nil
}
