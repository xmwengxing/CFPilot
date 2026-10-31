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
	"errors"
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

// workersPermHint 是 Workers 模式额外需要的权限（比 Pages 多三项）。
//
// 绑定自定义域名要 PUT /accounts/{id}/workers/domains，
// 它同时依赖账号级 Workers Routes 与域级 DNS —— 与 Pages 用的三项权限完全不相交。
var workersPermHint = struct {
	scripts string
	domains string
	dns     string
}{
	scripts: "Token 中添加 Account / Workers Scripts / Edit",
	domains: "Token 中添加 Account / Workers Routes / Edit（账号级）",
	dns:     "Token 中添加 Zone / DNS / Edit（自定义域名要自动建 DNS 记录）",
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

// preflightWorkersDataPlane 部署前权限预检（只读，不创建任何资源）。
//
// ## 为什么必须先预检
//
// 改动前的行为：脚本上传成功 → 绑域名 403 → 整条部署抛出 →
// 控制面根本没部署，账号里留下一个没域名、不接流量的孤儿 Worker。
// 用户只看到「部署失败」，既不知道是权限问题，也不知道要清理什么。
//
// 现在缺权限**在上传任何东西之前**就中止，并直接告诉用户缺哪一项。
func (d *Deployer) preflightWorkersDataPlane(
	ctx context.Context, hostname string, expectLeftoverDns bool,
) (*cfapi.Zone, error) {
	d.log("· 预检 Workers 数据面所需权限…")

	if _, err := d.client.ListScripts(ctx, d.opt.AccountID); err != nil {
		if isPermissionErr(err) {
			return nil, fmt.Errorf("Token 缺少「Workers 脚本」权限（%v）。\n"+
				"  → %s\n"+
				"  → Workers 模式比 Pages 模式多需要这几项权限；不想加权限就把数据面部署模式改回 Pages。",
				err, workersPermHint.scripts)
		}
		d.warn(fmt.Sprintf("无法读取 Workers 脚本列表：%v", err))
	} else {
		d.log("  · Workers 脚本权限正常")
	}

	if _, err := d.client.ListWorkerDomains(ctx, d.opt.AccountID); err != nil {
		if isPermissionErr(err) {
			return nil, fmt.Errorf("Token 缺少「Workers 自定义域名」权限（%v）。\n"+
				"  → %s\n"+
				"  → Workers 模式比 Pages 模式多需要这几项权限；不想加权限就把数据面部署模式改回 Pages。",
				err, workersPermHint.domains)
		}
		d.warn(fmt.Sprintf("无法读取 Workers 自定义域名列表：%v", err))
	} else {
		d.log("  · Workers 自定义域名权限正常")
	}

	if hostname == "" {
		return nil, nil
	}

	zone, err := d.resolveZoneForHost(ctx, hostname)
	if err != nil {
		return nil, err
	}
	if zone == nil {
		return nil, fmt.Errorf(
			"域名 %s 不在本账号的任何 zone 下，无法绑定为 Worker 自定义域名。\n"+
				"  → Workers 自定义域名不支持外部 CNAME，域名的 DNS 必须托管在这个 Cloudflare 账号里。\n"+
				"  → 换一个本账号下的域名，或把数据面部署模式改回 Pages（*.pages.dev 不需要自有域名）。",
			hostname)
	}
	d.log("  · 域名 " + hostname + " 归属 zone " + zone.Name)

	// DNS 只告警不阻断 —— **但换形态例外**：
	// 主机名下一定有条 Pages 遗留的 CNAME，删它必须有 DNS 写权限，
	// 读都读不到 = 一定没有写。这时必须在动线上域名之前拦下。
	if _, derr := d.client.ListDNSRecords(ctx, zone.ID, hostname); derr != nil {
		if expectLeftoverDns {
			return nil, fmt.Errorf(
				"换形态需要删除 %s 上 Pages 遗留的 DNS 记录，但当前令牌读不到 DNS（%v）。\n"+
					"  → %s\n"+
					"  → 或者（任选其一，都不需要 DNS 权限）：\n"+
					"     1) 到 Cloudflare 控制台 → 该域名的 DNS 页，手动删掉这个主机名下的记录，再重跑；\n"+
					"     2) 给数据面换一个新子域（如 w1.你的域名）—— 绑新域名由 Cloudflare 自己建记录，不需要 DNS 权限。\n"+
					"  → 不想折腾就把数据面部署模式改回 Pages。",
				hostname, derr, workersPermHint.dns)
		}
		if isPermissionErr(derr) {
			// 同时打到日志里：只塞进 warnings 的话，用户在部署过程中看不到，
			// 等到绑定失败才知道缺权限，白等一轮。
			d.log("  ⚠ Zone DNS 权限缺失或不可读（换形态时可能无法自动清理旧记录）")
			d.warn("可能缺少 Zone / DNS 权限（" + workersPermHint.dns + "）\n" +
				"  → 绑定域名时若报权限错误，补这一项即可。")
		} else {
			d.log(fmt.Sprintf("  ⚠ 无法读取 DNS 记录：%v", derr))
			d.warn(fmt.Sprintf("无法读取 DNS 记录：%v", derr))
		}
	} else {
		d.log("  · Zone DNS 权限正常")
	}

	return zone, nil
}

// isPagesLeftoverDns 判断一条 DNS 记录是否是 Pages 绑定留下的。
//
// 判据：CNAME 且指向 *.pages.dev。其余记录一律不动 —— 那可能是用户自己的
// 业务记录，删错了比部署失败严重得多。
func isPagesLeftoverDns(r cfapi.DNSRecord) bool {
	return r.Type == "CNAME" && strings.HasSuffix(strings.ToLower(strings.TrimSuffix(r.Content, ".")), ".pages.dev")
}

// clearPagesLeftoverDns 清理 Pages 绑定留下的 DNS 记录。
//
// ## 为什么必须有这一步（真机 409 / code 100117）
//
// Pages 给项目绑自定义域名时会自动建一条 CNAME（指向 `<项目>.pages.dev`）。
// 解绑 Pages 域名时**这条 DNS 记录不一定会被删掉** —— 于是紧接着去绑
// Worker 自定义域名就会撞：
//
//	Hostname 'x.example.com' already has externally managed DNS records
//	(A, CNAME, etc). Delete them first or try a different hostname.
//	（HTTP 409，code 100117）
//
// 也就是说「解绑 Pages 域名」只释放了项目侧占用，**没有释放主机名本身**。
// 换形态（Pages → Workers）必然踩到，因为两边用的是同一个域名。
func (d *Deployer) clearPagesLeftoverDns(ctx context.Context, zoneID, hostname string) error {
	// ⚠️ 这一步是**尽力而为**，不是必需前置。
	//
	// 真机踩过：令牌有 Workers Routes 但没有 Zone / DNS，读 dns_records 直接
	// 403 Authentication error —— 于是整个部署在这里中断，报错只说
	// Authentication error，用户完全看不出是 DNS 权限问题。
	//
	// 而「没有残留记录」时 DNS 权限其实用不上。所以读不到就跳过，
	// 真正的失败留给绑定那一步（那里能给出 100117 的准确提示）。
	records, err := d.client.ListDNSRecords(ctx, zoneID, hostname)
	if err != nil {
		if isPermissionErr(err) {
			d.log("⚠ 无法读取 DNS 记录，跳过残留清理")
			d.warn(fmt.Sprintf(
				"无法读取 DNS 记录（缺 Zone / DNS 权限），已跳过「Pages 遗留记录」清理。\n"+
					"  → 若接下来绑定域名报 409 / 100117，请给令牌加 Zone / DNS / Edit，\n"+
					"    或到 Cloudflare 控制台手动删除 %s 下的 CNAME 记录。", hostname))
			return nil
		}
		return err
	}

	var leftovers, others []cfapi.DNSRecord
	for _, r := range records {
		if !strings.EqualFold(r.Name, hostname) {
			continue
		}
		if isPagesLeftoverDns(r) {
			leftovers = append(leftovers, r)
		} else {
			others = append(others, r)
		}
	}

	for _, r := range leftovers {
		if derr := d.client.DeleteDNSRecord(ctx, zoneID, r.ID); derr != nil {
			// 删不掉（权限不足 / 并发改动）→ 不再继续，交给绑定那一步报 100117
			d.log(fmt.Sprintf("⚠ 清理 DNS 记录失败：%v", derr))
			d.warn(fmt.Sprintf(
				"无法删除 %s 上的 Pages 遗留记录（%s %s）：%v\n"+
					"  → 请给令牌加 Zone / DNS / Edit，或到控制台手动删除该记录。",
				hostname, r.Type, r.Content, derr))
			return nil
		}
		d.log(fmt.Sprintf("· 已清理 Pages 遗留的 DNS 记录：%s %s → %s", r.Type, r.Name, r.Content))
	}
	if len(leftovers) > 0 {
		d.warn(fmt.Sprintf(
			"已删除 %s 上 %d 条 Pages 遗留的 DNS 记录（CNAME → *.pages.dev）。\n"+
				"  → 这些记录原本指向旧的 Pages 数据面，迁移到 Workers 后由 Workers 自己接管该主机名。",
			hostname, len(leftovers)))
	}

	if len(others) > 0 {
		parts := make([]string, 0, len(others))
		for _, r := range others {
			parts = append(parts, r.Type+" "+r.Content)
		}
		return fmt.Errorf(
			"%s 上还有 %d 条非 Pages 的 DNS 记录（%s）。\n"+
				"  → Workers 自定义域名要求该主机名**没有任何现存记录**，否则会返回 409 / 100117。\n"+
				"  → 请到 Cloudflare 控制台 → DNS 里删掉它们，或换一个没用过的子域。",
			hostname, len(others), strings.Join(parts, "、"))
	}
	return nil
}

// attachWorkerDomainWithRetry 绑定自定义域名，100117 时短暂重试。
//
// 刚删掉的 DNS 记录在边缘侧生效有延迟，409 会短暂残留 —— 直接失败太武断。
func (d *Deployer) attachWorkerDomainWithRetry(
	ctx context.Context, hostname, service, zoneID string,
) (*cfapi.WorkerDomain, error) {
	const maxAttempts = 3
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		domain, err := d.client.AttachWorkerDomain(ctx, d.opt.AccountID, hostname, service, zoneID)
		if err == nil {
			return domain, nil
		}
		lastErr = err
		msg := strings.ToLower(err.Error())
		transient := strings.Contains(msg, "100117") || strings.Contains(msg, "externally managed")
		if !transient || attempt == maxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}

	if isPermissionErr(lastErr) {
		return nil, fmt.Errorf(
			"绑定自定义域名 %s 被拒绝（权限不足）。\n  → %s\n  → %s\n"+
				"  → 也可以先不绑域名：把「自定义域名」留空，部署到 *.workers.dev（多数网络下直连不可访问）。",
			hostname, workersPermHint.domains, workersPermHint.dns)
	}
	msg := strings.ToLower(lastErr.Error())
	if strings.Contains(msg, "100117") || strings.Contains(msg, "externally managed") {
		zoneHint := hostname
		if i := strings.Index(hostname, "."); i > 0 {
			zoneHint = hostname[i+1:]
		}
		return nil, fmt.Errorf(
			"%s 上仍有 DNS 记录占用，Workers 无法接管该主机名（HTTP 409 / 100117）。\n"+
				"  → 这些记录通常是 Pages 绑定时自动建的 CNAME（指向 *.pages.dev），解绑 Pages 域名不会删掉它。\n"+
				"  → 三种解法（任选其一）：\n"+
				"    1) 给令牌加 Zone / DNS / Edit，程序会自动清理后重试；\n"+
				"    2) 到 Cloudflare 控制台 → %s 的 DNS 页，删掉这个主机名下的记录；\n"+
				"    3) 换一个没用过的子域（如 w1.你的域名）作为数据面域名。",
			hostname, zoneHint)
	}
	return nil, lastErr
}

// deployWorkersDataPlane 上传脚本 → 绑域名（或开 workers.dev）→ 校验可达。
//
// 返回客户端要连的域名与绑定的自定义域名（没绑则空串）。
func (d *Deployer) deployWorkersDataPlane(
	ctx context.Context, name string, eff effective, hostname string, zone *cfapi.Zone,
) (host string, customDomain string, err error) {
	d.log("· 上传 Workers 数据面脚本 " + name)
	if err := d.client.UploadWorkerScript(
		ctx, d.opt.AccountID, name, d.opt.DataScript, d.workersBindings(eff), workersCompatDate,
	); err != nil {
		return "", "", err
	}

	if hostname != "" {
		target := zone
		if target == nil {
			z, zerr := d.resolveZoneForHost(ctx, hostname)
			if zerr != nil {
				return "", "", zerr
			}
			target = z
		}
		if target == nil {
			return "", "", fmt.Errorf(
				"域名 %s 不在本账号的任何 zone 下，无法绑定为 Worker 自定义域名。"+
					"请确认该域名的 DNS 托管在这个 Cloudflare 账号里", hostname)
		}

		// ⚠️ 绑之前必须先清掉 Pages 遗留的 DNS 记录，否则必然 409 / 100117：
		// 「解绑 Pages 域名」只释放项目侧占用，那条指向 *.pages.dev 的 CNAME 还在。
		if cerr := d.clearPagesLeftoverDns(ctx, target.ID, hostname); cerr != nil {
			return "", "", cerr
		}
		if _, aerr := d.attachWorkerDomainWithRetry(ctx, hostname, name, target.ID); aerr != nil {
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
