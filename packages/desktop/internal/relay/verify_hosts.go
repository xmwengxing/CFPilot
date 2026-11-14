package relay

// 反代优选的「校验网址」：
//
// 反代入口是第三方按 SNI 转发的服务器，仅凭「能转发到自己的数据面」
// 判定入口可用是不够的 —— 有些入口只白名单了特定 SNI，对别的站点
// 直接断连或丢包。终检阶段用一组**Cloudflare 网段的知名站点**实测
// 「这个入口能不能把流量转到 CF 边缘」，不能的剔除。
//
// ## 为什么内置清单不做运行时 DNS 剔除
//
// 清单里的站点是我们离线确认过「权威解析稳定落在 Cloudflare 网段」的。
// 国内网络的本地 DNS 会把大量 CF 站点解析到本地 CDN（x.com → Fastly、
// chatgpt.com → 国内 IP），如果按运行端解析结果剔除，内置清单会被误杀光。
// 所以：内置清单豁免 DNS 剔除；用户手填的网址才按解析结果剔除
// （解析结果完全不在 CF 网段 → 剔除，避免「拿百度校验反代」这类失真）。

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"
)

// builtinVerifyHosts 是内置的校验网址（权威解析稳定落在 Cloudflare 网段）。
var builtinVerifyHosts = []string{
	"cloudflare.com",
	"chatgpt.com",
	"canva.com",
	"discord.com",
	"x.com",
}

// BuiltinVerifyHosts 返回内置校验网址（界面预填 / 无手填时使用）。
func BuiltinVerifyHosts() []string {
	out := make([]string, len(builtinVerifyHosts))
	copy(out, builtinVerifyHosts)
	return out
}

// isBuiltinVerifyHost 判断 host 是否在内置清单里（内置豁免 DNS 剔除）。
func isBuiltinVerifyHost(host string) bool {
	for _, h := range builtinVerifyHosts {
		if h == host {
			return true
		}
	}
	return false
}

// cloudflareRanges 是 Cloudflare 自家网段（覆盖官方公开的主地址段）。
// 只用于「校验网址是否 CF 网段」这个判定，不需要完整表；
// 与 CLI 版 outbound/route.ts 的 CF 网段表同源（按需同步）。
var cloudflareRanges = []struct {
	base [4]byte
	bits int
}{
	{[4]byte{104, 16, 0, 0}, 13},
	{[4]byte{104, 24, 0, 0}, 14},
	{[4]byte{172, 64, 0, 0}, 13},
	{[4]byte{162, 158, 0, 0}, 15},
	{[4]byte{188, 114, 96, 0}, 20},
	{[4]byte{198, 41, 128, 0}, 17},
	{[4]byte{103, 21, 244, 0}, 22},
	{[4]byte{103, 22, 200, 0}, 22},
	{[4]byte{103, 31, 4, 0}, 22},
	{[4]byte{141, 101, 64, 0}, 18},
	{[4]byte{108, 162, 192, 0}, 18},
	{[4]byte{190, 93, 240, 0}, 20},
	{[4]byte{197, 234, 240, 0}, 22},
	{[4]byte{131, 0, 72, 0}, 22},
	{[4]byte{1, 0, 0, 0}, 24},
	{[4]byte{1, 1, 1, 0}, 24},
}

// isCloudflareIPv4 判断 IPv4 字面量是否落在 Cloudflare 网段。
func isCloudflareIPv4(ip string) bool {
	parsed := net.ParseIP(ip)
	v4 := parsed.To4()
	if v4 == nil || parsed == nil {
		return false
	}
	for _, r := range cloudflareRanges {
		if cidrMatch(v4, r.base, r.bits) {
			return true
		}
	}
	return false
}

// cidrMatch 判断 ip 是否落在 base/bits 网段内。
func cidrMatch(ip net.IP, base [4]byte, bits int) bool {
	mask := net.CIDRMask(bits, 32)
	ipNet := net.IPNet{IP: net.IP(base[:]).To4(), Mask: mask}
	return ipNet.Contains(ip)
}

// verifyHostLookup 是校验网址的 DNS 解析入口（测试可注入）。
var verifyHostLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

// ResolveVerifyHosts 把「用户手填 + 内置」合并成实际用于终检的网址列表：
//
//   - 用户没填 → 直接用内置清单（豁免 DNS 剔除）；
//   - 用户填了 → 逐个解析 A 记录：任一 IP 落在 CF 网段 → 保留；
//     完全不在 CF 网段（或解析失败）→ 剔除并记录原因（防「拿百度校验反代」）；
//     内置清单里的 host 豁免（理由见文件头）；
//   - 合并去重后按给定顺序返回，上限 verifyHostLimit 个（终检成本控制）。
//
// logf 可为空；剔除原因会通过它回传给用户。
func ResolveVerifyHosts(userHosts []string, logf func(string)) []string {
	// 终检成本：每候选 × 每网址一次完整隧道探测，3 个网址在
	// 「全通候选 × 3」的量级上可控，再多探测时长会线性膨胀。
	const verifyHostLimit = 3

	normalize := func(s string) string {
		return strings.ToLower(strings.TrimSpace(s))
	}

	seen := map[string]bool{}
	var out []string
	add := func(host string) {
		host = normalize(host)
		if host == "" || seen[host] || len(out) >= verifyHostLimit {
			return
		}
		seen[host] = true
		out = append(out, host)
	}

	// 用户手填的在前（用户显式指定的优先被验证）
	for _, raw := range userHosts {
		host := normalize(raw)
		if host == "" {
			continue
		}
		if isBuiltinVerifyHost(host) {
			add(host) // 内置清单豁免 DNS 剔除
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		addrs, err := verifyHostLookup(ctx, host)
		cancel()
		if err != nil {
			if logf != nil {
				logf(fmt.Sprintf("已剔除校验网址 %s（解析失败）", host))
			}
			continue
		}
		anyCF := false
		for _, a := range addrs {
			if v4 := a.IP.To4(); v4 != nil && isCloudflareIPv4(v4.String()) {
				anyCF = true
				break
			}
		}
		if !anyCF {
			if logf != nil {
				logf(fmt.Sprintf("已剔除校验网址 %s（解析结果不在 Cloudflare 网段）", host))
			}
			continue
		}
		add(host)
	}
	// 内置清单补位（用户没填 / 填的都被剔光时兜底）
	for _, h := range builtinVerifyHosts {
		if len(out) >= verifyHostLimit {
			break
		}
		add(h)
	}
	return out
}
