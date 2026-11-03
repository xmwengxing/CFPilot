package scan

// IPv6 环境预检 —— 与 CLI 的 packages/cli/src/scan/ipv6-env.ts 一一对应。
//
// ## 为什么必须先预检
//
// IPv6 候选是**字面量地址**，与本机有没有可用的 IPv6 出口完全无关 ——
// 本机不通 v6 时，成千上万个 v6 候选会**全部超时**，
// 而且这些失败若被写进网络档案，会把「本机没 v6」学成「v6 网段不可用」，
// **永久毒化历史**。所以预检失败时：不生成 v6 候选、不写任何负向观测。
//
// ## 三态
//
//	ok          有公网地址 + 有默认路由 + 金丝雀连通
//	no-address  没有 2000::/3 的公网地址
//	no-route    有地址但没有默认 IPv6 路由（::/0）
//	no-internet 有地址有路由但金丝雀全失败
//
// ⚠️ 显式要求 v6 时**不阻断**，只把结论交给调用方提示 ——
// 用户明确要扫 v6 就让他扫，静默改成纯 v4 反而无法解释「为什么一条都没有」。

import (
	"context"
	"net"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// IPv6EnvStatus 是预检结论（三态 + 成功态）。
type IPv6EnvStatus string

const (
	IPv6EnvOK         IPv6EnvStatus = "ok"
	IPv6EnvNoAddress  IPv6EnvStatus = "no-address"
	IPv6EnvNoRoute    IPv6EnvStatus = "no-route"
	IPv6EnvNoInternet IPv6EnvStatus = "no-internet"
)

// IPv6EnvResult 是一次预检的完整结论（直接序列化给界面）。
type IPv6EnvResult struct {
	Status          IPv6EnvStatus `json:"status"`
	Address         string        `json:"address"`
	InterfaceName   string        `json:"interfaceName"`
	HasDefaultRoute *bool         `json:"hasDefaultRoute"`
	CanaryTried     int           `json:"canaryTried"`
	CanaryOk        int           `json:"canaryOk"`
	Message         string        `json:"message"`
	Advice          []string      `json:"advice"`
	ElapsedMs       int64         `json:"elapsedMs"`
}

// notReadyPrefix 是面向用户的固定前缀，与界面提示保持同一句话。
const notReadyPrefix = "当前网络环境不具备 IPv6 测速条件"

// 三个探测点做成包级变量，单测可以替换成假实现（不碰真实网络与真实路由表）。
var (
	findGlobalIPv6Fn = defaultFindGlobalIPv6
	probeRouteFn     = defaultProbeRoute
	tcpReachableFn   = defaultTCPReachable
)

// defaultFindGlobalIPv6 扫描网卡，取第一个公网全局单播 IPv6 地址。
func defaultFindGlobalIPv6() (address, ifaceName string, ok bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", "", false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, okAddr := addr.(*net.IPNet)
			if !okAddr || ipnet.IP == nil {
				continue
			}
			if ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() {
				continue
			}
			if isPublicIPv6(ipnet.IP.String()) {
				return ipnet.IP.String(), iface.Name, true
			}
		}
	}
	return "", "", false
}

// defaultProbeRoute 探测本机是否有默认 IPv6 路由（**尽力而为**，失败返回 nil）。
//
// 路由表没有跨平台的标准库 API，只能调各平台自带命令：
//   - Windows：`route print -6` 里找 `::/0`（与界面语言无关，字面量稳定）
//   - Linux  ：`ip -6 route show default`
//   - macOS  ：`netstat -rn -f inet6` 里找 `default`
//
// 任何一步失败（命令不存在 / 超时 / 权限）都返回 nil ——
// 路由判定是**加分项**，不能因为它让整个预检崩掉。
func defaultProbeRoute(timeout time.Duration) *bool {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.CommandContext(ctx, "route", "print", "-6")
	case "darwin":
		cmd = exec.CommandContext(ctx, "netstat", "-rn", "-f", "inet6")
	default:
		cmd = exec.CommandContext(ctx, "ip", "-6", "route", "show", "default")
	}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	text := string(out)
	var found bool
	switch runtime.GOOS {
	case "windows":
		found = strings.Contains(text, "::/0")
	default:
		found = strings.Contains(text, "default")
	}
	return &found
}

// defaultTCPReachable 单个金丝雀地址的 TCP 连通性（与扫描阶段一同口径）。
func defaultTCPReachable(address string, port int, timeout time.Duration) bool {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort(address, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// DetectIPv6Env 执行 IPv6 环境预检。
//
// 顺序：**地址 → 路由 → 金丝雀**，任一步失败立即定性返回，
// 不再往下浪费时间（金丝雀默认 1.5s，全失败也要等一轮）。
func DetectIPv6Env(canary []string, timeout time.Duration) IPv6EnvResult {
	started := time.Now()
	if timeout <= 0 {
		timeout = 1500 * time.Millisecond
	}
	result := func(status IPv6EnvStatus, address, ifaceName string, route *bool, tried, okCount int, message string, advice []string) IPv6EnvResult {
		return IPv6EnvResult{
			Status: status, Address: address, InterfaceName: ifaceName,
			HasDefaultRoute: route, CanaryTried: tried, CanaryOk: okCount,
			Message: message, Advice: advice,
			ElapsedMs: time.Since(started).Milliseconds(),
		}
	}

	address, ifaceName, found := findGlobalIPv6Fn()
	if !found {
		return result(IPv6EnvNoAddress, "", "", nil, 0, 0,
			notReadyPrefix+"：本机没有可用的公网 IPv6 地址", ipv6EnvAdvice(IPv6EnvNoAddress))
	}

	route := probeRouteFn(timeout)
	if route != nil && !*route {
		return result(IPv6EnvNoRoute, address, ifaceName, route, 0, 0,
			notReadyPrefix+"：有 IPv6 地址但没有默认 IPv6 路由", ipv6EnvAdvice(IPv6EnvNoRoute))
	}

	if len(canary) == 0 {
		// 没有可用的金丝雀（活跃前缀池为空）：地址与路由都正常就放行
		return result(IPv6EnvOK, address, ifaceName, route, 0, 0,
			"IPv6 环境可用（"+address+" @ "+ifaceName+"，未做金丝雀探测）", nil)
	}

	// 金丝雀**并发**探测：串行最坏是「个数 × 超时」，
	// 而这段每次开始优选都会跑 —— 本机 v6 不通时等于白等几秒。
	ch := make(chan bool, len(canary))
	for _, ip := range canary {
		go func(address string) {
			ch <- tcpReachableFn(address, 443, timeout)
		}(ip)
	}
	okCount := 0
	for range canary {
		if <-ch {
			okCount++
		}
	}
	if okCount == 0 {
		return result(IPv6EnvNoInternet, address, ifaceName, route, len(canary), 0,
			notReadyPrefix+"：金丝雀目标 "+itoa(len(canary))+" 个全部连不通", ipv6EnvAdvice(IPv6EnvNoInternet))
	}
	return result(IPv6EnvOK, address, ifaceName, route, len(canary), okCount,
		"IPv6 环境可用（"+address+" @ "+ifaceName+"，金丝雀 "+itoa(okCount)+"/"+itoa(len(canary))+"）", nil)
}

func itoa(n int) string { return strconv.Itoa(n) }

// ipv6EnvAdvice 给出面向用户的排查建议（与 CLI 的 buildAdvice 一致）。
func ipv6EnvAdvice(status IPv6EnvStatus) []string {
	switch status {
	case IPv6EnvNoAddress:
		return []string{
			"网卡上没有 2000::/3 的公网 IPv6 地址（仅有 fe80:: 链路本地或 fc00::/7 虚拟地址不算）",
			"确认光猫/路由器已开启 IPv6，且系统网卡未禁用 IPv6 协议",
			"部分虚拟组网工具会接管 IPv6，可先退出再试",
		}
	case IPv6EnvNoRoute:
		return []string{
			"有公网 IPv6 地址，但路由表里没有默认 IPv6 路由（::/0）",
			"检查路由器是否下发 RA、系统是否拿到了网关",
			"可先断开代理/VPN 后重试，确认是它吃掉了 v6 路由",
		}
	case IPv6EnvNoInternet:
		return []string{
			"有地址也有默认路由，但金丝雀目标全部连不通",
			"常见原因：代理工具的 TUN 模式接管了 IPv6 但没有可用出口",
			"也可能是运营商 IPv6 国际出口异常（国内目标通、国际目标不通）",
			"可用 cfpilot scan --family v6 --json 单独复查并看失败分布",
		}
	}
	return nil
}

// DiscoverIPv6Prefixes 从一批域名的 AAAA 记录里发现**活跃的 48 位前缀**。
//
// ## 为什么这是最可靠的 v6 候选来源
//
// 2026-11-03 实测：Cloudflare 公布的 IPv6 聚合段里随机抽 48 位前缀 **0/18 全超时**，
// 而「已知活跃段内随机 IID」TCP 6/6、TLS 4/4、WS101 8/8 ——
// 可用性是 **48 位前缀**粒度，且只有少数前缀真的在用。
//
// 用户自己域名的 AAAA 记录**永远指向当下真正在用的那些前缀**，
// 不依赖任何静态表、不会过期，所以排在静态表之前作为 L0 来源。
// 解析失败 / 超时 / 没有 AAAA 一律静默跳过（这只是补充来源，不是主流程）。
//
// 对照 CLI 的 candidates.ts `discoverIPv6Prefixes()`。
func DiscoverIPv6Prefixes(hosts []string, timeout time.Duration) []string {
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	found := make(map[string]bool)
	for _, raw := range hosts {
		host := strings.ToLower(strings.TrimSpace(raw))
		host = strings.TrimPrefix(host, "https://")
		host = strings.TrimPrefix(host, "http://")
		if idx := strings.IndexAny(host, "/?#"); idx >= 0 {
			host = host[:idx]
		}
		// 空、或本身就是 IP 字面量（没有 AAAA 可查）
		if host == "" || net.ParseIP(host) != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		addrs, err := net.DefaultResolver.LookupIP(ctx, "ip6", host)
		cancel()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if key := IPv6Prefix48(addr.String()); key != "" {
				found[key] = true
			}
		}
	}
	out := make([]string, 0, len(found))
	for key := range found {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// CanaryAddresses 从活跃前缀池里取最多 n 个**金丝雀地址**。
//
// 金丝雀必须来自实测活跃段：随便挑公布段地址会 100% 超时，
// 于是「环境没问题」也会被判成 no-internet。
// 对照 CLI 的 candidates.ts `pickCanary()`。
func CanaryAddresses(pool []string, n int) []string {
	if n <= 0 {
		return nil
	}
	out := make([]string, 0, n)
	for _, prefix := range pool {
		if len(out) >= n {
			break
		}
		// seed 0 = 密码学随机：金丝雀不需要可复现
		if ips := sampleFromCIDR(prefix, 1, 0); len(ips) > 0 {
			out = append(out, ips[0])
		}
	}
	return out
}
