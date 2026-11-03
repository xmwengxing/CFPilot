package scan

// Cloudflare IPv4 网段库与加权采样。
//
// ## ⚠️ 这张权重表是真机实测出来的，不要凭直觉改
//
// Cloudflare 的 IPv4 空间里大部分是区域/租户专用分配，对普通站点没有配置
// （返回 400 或超时）。**按网段大小平均分配采样预算**会让一半以上候选
// 来自 0% 可用的网段，真机表现是「阶段一过后只剩零星候选、阶段二全军覆没」。
//
// 实测数据（VLESS over WS 101 校验，每段 12 IP，2026-10-25）：
//
//	104.16.0.0/13   8/12
//	104.24.0.0/14   7/12
//	103.21.244.0/22 3/12
//	103.31.4.0/22   3/12
//	190.93.240.0/20 3/12
//	188.114.96.0/20 3/12
//	141.101.64.0/18 2/12
//	162.158.0.0/15  2/12
//	172.64.0.0/13   1/12
//	173.245.48.0/20 0/12
//	103.22.200.0/22 0/12
//	108.162.192.0/18 0/12
//	197.234.240.0/22 0/12
//	198.41.128.0/17 0/12
//	131.0.72.0/22   0/12
//
// ## 两个额外教训
//
//  1. **`162.159.0.0/16` 是 Cloudflare 的管理/API 网段**（被 162.158.0.0/15 覆盖），
//     真机实测多数返回 HTTP 403（反爬风控）。但**并非全部** ——
//     用户实测 162.159.237.59 可用（2.8 MB/s），本地复测也通过（SJC）。
//     所以**不能压到 0**（会错杀可用 IP），给一个很低的权重 0.05。
//     教训：权重粒度是 /16，但实际可用性可能细到单个 IP，样本太少别下死结论。
//
//  2. **可用性可能细到 /24**：同一 `103.21.244.0/22` 里
//     `103.21.244.x` 16/16 全过、`103.21.245.x` 0/14 全挂。
//     因此低权重网段仍会采到废 IP，真正的剔除靠阶段二校验。

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math/big"
	mathrand "math/rand"
	"net"
	"sort"
	"strings"
)

// BuiltinIPv4CIDRs 是 Cloudflare 公开的 IPv4 网段。
var BuiltinIPv4CIDRs = []string{
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
}

// ipv4CidrWeights 是各网段的可用率权重（0~1）。
//
// 未列出的网段用 DefaultCIDRWeight。
// 采样预算按 `size × weight` 分配：
//   - 权重 0 的网段**完全不参与采样**（实测 0/12，采了也是浪费）
//   - 权重高的网段拿到更多候选
var ipv4CidrWeights = map[string]float64{
	"104.16.0.0/13":   0.9,  // 适配 2026-10-28 复测
	"104.24.0.0/14":   0.95, // 适配 2026-10-28 复测
	"103.21.244.0/22": 0.35, // 实测 3/12
	"103.31.4.0/22":   0.3,  // 实测 3/12
	"190.93.240.0/20": 0.25, // 实测 3/12
	"188.114.96.0/20": 0.75, // 实测 3/12
	"141.101.64.0/18": 0.05, // 实测 2/12
	"162.158.0.0/16":  0.3,  // 162.158.x.x 边缘节点，部分可用
	// 162.159.x.x 是管理/API 网段，多数 403，但少数可用（见文件头教训 1）
	"162.159.0.0/16": 0.05,
	"172.64.0.0/13":  0.55, // 适配 2026-10-29 实测（该段可出高速节点）

	// 实测 0/12 —— 不采样
	"173.245.48.0/20":  0,
	"103.22.200.0/22":  0,
	"108.162.192.0/18": 0,
	"197.234.240.0/22": 0,
	"198.41.128.0/17":  0,
	"131.0.72.0/22":    0,
}

// cidrWeightForWithExtra 返回采样用权重（neutral 时忽略权重差异，只保留 0 = 不可达）。
//
// 静态表会漂移，而用户自己域名的 AAAA **永远指向当下真正在用的段**，
// 有它兜底，静态表过期也不会让 v6 采样变成 0 候选。
func cidrWeightForWithExtra(cidr string, neutral bool, extra []string) float64 {
	w := CIDRWeight(cidr)
	if w <= 0 && len(extra) > 0 && isIPv6CIDR(cidr) {
		if key := IPv6Prefix48(cidr); key != "" {
			for _, e := range extra {
				if IPv6Prefix48(e) == key {
					w = 1
					break
				}
			}
		}
	}
	if neutral && w > 0 {
		return 1
	}
	return w
}

// DefaultCIDRWeight 是未列入权重表的网段的默认权重（保守取中等偏低）。
const DefaultCIDRWeight = 0.2

// BuiltinIPv6CIDRs 是 Cloudflare 公开的 IPv6 **聚合段**。
//
// ⚠️ 它们只是「分配」，不是「在用」：2026-11-03 实测在这些段里随机抽 48 位前缀
// **0/18 全超时**，而已知活跃段内随机 IID 则 TCP 6/6、TLS 4/4、WS101 8/8。
// 所以**绝不能拿这张表当采样池** —— 真正的池子是 ipv6PrefixWeights 里权重 > 0 的段
// （对照 CLI 的 IPV6_ACTIVE_PREFIXES）。保留它只为了文档与「官方列表」语义。
var BuiltinIPv6CIDRs = []string{
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
}

// ipv6PrefixWeights 对照 CLI 的 IPV6_PREFIX_WEIGHTS，**逐项一致**。
//
// ## 为什么 v6 必须自成一张表、且默认 0
//
// 2026-11-03 实测（本机原生 IPv6，SNI = 自己的数据面域名，端口 443）：
//
//	在公布聚合段里随机取 48 位前缀      0/18 全超时
//	在已知活跃 48 位段内随机 IID        TCP 6/6、TLS 4/4、WS101 8/8
//
// 结论：**IPv6 的可用性粒度是 48 位前缀，且只有少数前缀真的在用**。
// 未列入本表的 v6 段默认权重 0（不参与采样），与 v4 的 0.2（宁可多采）取值相反，
// 这是有意的：v6 侧没有「宁可多采」的本钱，盲采只会把预算烧在死地址上。
//
// ## 只有两档，没有中间档
//
// 曾给「仅 TCP 通」的段留了 0.5，复测发现其中 4 段 WS101 **12/12 全 403** ——
// 中间档只会让预算流向注定出不了结果的段。判据只认 WS101，不认 TCP。
//
// ⚠️ 同 v4 权重表一样，这张表是启发式且会漂移，**改表前必须复测**：
//
//	cfpilot scan --host <数据面域名> --family v6 --sample 300 --json --no-callback
var ipv6PrefixWeights = map[string]float64{
	// ---- WS101 实测通过（1）----
	"2606:4700:3035::/48": 1, // 自己域名 AAAA 所在段，WS101 → AMS
	"2606:4700:3037::/48": 1, // 自己域名 AAAA 所在段，WS101 → AMS
	"2606:4700:3030::/48": 1, // 随机 IID ×2 → AMS
	"2606:4700:10::/48":   1, // 随机 IID ×2 → FRA
	"2606:4700:20::/48":   1, // 随机 IID ×2 → FRA
	"2a06:98c1:3100::/48": 1, // 随机 IID ×2 → SIN
	"2606:4700::/48":      1, // cloudflare.com AAAA 所在段；扫描实测 WS101 → SJC
	"2606:4700:1::/48":    1, // 扫描实测 WS101 → SJC

	// ---- 实测不可用（0）----
	"2400:cb00:2048::/48": 0, // 随机 /64 ×4 全超时（TCP 层就不通）
	"2400:cb00:2049::/48": 0, // TCP/TLS 全通但 WS101 回 403 —— 「活跃 ≠ 可用」的实例
	// 以下 4 段复测：TCP/TLS 全通，WS101 **12/12 全部 403**。
	// 一次扫描里它们吃掉 42/120 的阶段二名额却一条都出不来，必须降到 0。
	"2606:4700:50::/48": 0,
	"2606:4700:58::/48": 0,
	"2803:f800:50::/48": 0,
	"2a06:98c1:50::/48": 0,
}

// DefaultIPv6CIDRWeight 是未列入 IPv6 权重表的段的默认权重：**不采样**。
const DefaultIPv6CIDRWeight = 0

// weightEntry6 是 IPv6 权重表的预解析条目（ones 降序 → 最长前缀优先）。
type weightEntry6 struct {
	ones   int
	ipnet  *net.IPNet
	weight float64
}

// ipv6WeightTable 是 IPv6 权重表的预解析结果（按前缀长度降序，最长前缀优先）。
var ipv6WeightTable = func() []weightEntry6 {
	out := make([]weightEntry6, 0, len(ipv6PrefixWeights))
	for tableCidr, w := range ipv6PrefixWeights {
		_, tNet, err := net.ParseCIDR(tableCidr)
		if err != nil {
			continue
		}
		ones, _ := tNet.Mask.Size()
		out = append(out, weightEntry6{ones: ones, ipnet: tNet, weight: w})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ones > out[j].ones })
	return out
}()

// IPv6Prefix48 把 IPv6 地址 / 网段归一成 `h1:h2:h3::/48`。
//
// 与 CLI 的 network-profile.ts `networkBucket()` / ip-ranges.ts `ipv6Prefix48()`
// **逐字节一致** —— 观测就是用这个字符串写进档案的，两边格式差一个 `0`
// 就永远查不到历史（v6 观测学不到就是这么来的：旧实现写的是 8 组不压缩的裸地址）。
//
// 例：`2606:4700:0:0:0:0:6810:85e5` → `2606:4700:0::/48`
//
// ⚠️ 注意是 `2606:4700:0::/48` 而不是 `2606:4700::/48` ——
// 三个十六进制组必须都写出来，与 TS 侧的模板字符串行为保持一致。
func IPv6Prefix48(value string) string {
	c := strings.TrimSpace(strings.Trim(strings.TrimSpace(value), "[]"))
	if c == "" {
		return ""
	}
	if !strings.Contains(c, "/") {
		c += "/48"
	}
	_, ipnet, err := net.ParseCIDR(c)
	if err != nil {
		return ""
	}
	if ipnet.IP.To4() != nil {
		return ""
	}
	b := ipnet.IP.To16()
	if b == nil {
		return ""
	}
	return fmt.Sprintf("%x:%x:%x::/48",
		binary.BigEndian.Uint16(b[0:2]),
		binary.BigEndian.Uint16(b[2:4]),
		binary.BigEndian.Uint16(b[4:6]))
}

// IPv6ActivePrefixes 返回权重 > 0 的 IPv6 前缀（已归一成 `x:x:x::/48` 形式）。
//
// 这就是 v6 的**采样池**：既当静态先验，也当预检金丝雀的地址来源
// （对照 CLI 的 IPV6_ACTIVE_PREFIXES）。
func IPv6ActivePrefixes() []string {
	out := make([]string, 0, len(ipv6PrefixWeights))
	for cidr, w := range ipv6PrefixWeights {
		if w > 0 {
			out = append(out, IPv6Prefix48(cidr))
		}
	}
	sort.Strings(out)
	return out
}

// CIDRWeight 返回某个网段的权重。
//
// 查找规则：
//  1. 精确命中权重表 → 用它
//  2. 否则找**最长前缀**的父网段（例：`162.159.1.0/24` 落到 `162.159.0.0/16`）
//  3. 都没有 → DefaultCIDRWeight
//
// weightEntry 权重表的预解析条目。
type weightEntry struct {
	ones   int
	base   uint32
	weight float64
}

// weightTable 权重表的预解析结果（包加载时构建一次）。
//
// 旧实现每次调用 CIDRWeight 都重新 net.ParseCIDR 整张表 ——
// 表里有几十条网段，而 SampleCandidates 会对每个网段调用一次，
// 相当于重复解析几千次常量。
var weightTable = func() []weightEntry {
	out := make([]weightEntry, 0, len(ipv4CidrWeights))
	for tableCidr, w := range ipv4CidrWeights {
		_, tNet, err := net.ParseCIDR(tableCidr)
		if err != nil {
			continue
		}
		tOnes, _ := tNet.Mask.Size()
		base := binary.BigEndian.Uint32(tNet.IP.To4())
		out = append(out, weightEntry{ones: tOnes, base: base, weight: w})
	}
	// 预先按「前缀长度降序」排好 —— 最长前缀优先，省掉每次调用的 sort
	sort.Slice(out, func(a, b int) bool {
		if out[a].ones != out[b].ones {
			return out[a].ones > out[b].ones
		}
		return out[a].base > out[b].base
	})
	return out
}()

func CIDRWeight(cidr string) float64 {
	normalized := normalizeCIDR(cidr)
	ip, ipnet, err := net.ParseCIDR(normalized)
	if err != nil {
		return DefaultCIDRWeight
	}

	// ---- IPv6：查 ipv6PrefixWeights，默认 0（没实测过的一律不采）----
	//
	// 对照 CLI 的 cidrWeight —— 两族的兜底值不同是刻意的：
	// v4 默认 0.2（宁可多采），v6 默认 0（盲采实测 0/18）。
	// ⚠️ 必须按 128 位做最长前缀匹配，写死 32 会右移错位、匹配到无关条目。
	if ip.To4() == nil {
		if w, ok := ipv6PrefixWeights[normalized]; ok {
			return w
		}
		ones, _ := ipnet.Mask.Size()
		for _, e := range ipv6WeightTable {
			// 条目必须不比查询更具体（e.ones <= ones），否则它覆盖不了查询段
			if e.ones > ones {
				continue
			}
			if e.ipnet.Contains(ip) {
				return e.weight
			}
		}
		return DefaultIPv6CIDRWeight
	}

	if w, ok := ipv4CidrWeights[normalized]; ok {
		return w
	}
	ones, _ := ipnet.Mask.Size()

	// 找最长前缀（前缀越长越具体）。
	//
	// 条件说明：要在权重表里找一个**覆盖** ip 的网段，
	// 且它的前缀必须**短于**查询的网段（`tOnes < ones`）——
	// 「父网段」的定义就是前缀更短、范围更大。
	//
	// ⚠️ 曾写成 `tOnes <= ones` 并在命中后 `continue`，逻辑正好写反：
	// 把唯一覆盖它的父网段（/17 相对 /24）当成不合法跳过了，
	// 于是 `198.41.130.0/24`（属于实测 0/12 的网段）回落成默认权重 0.2，
	// 让本该完全不采样的网段漏进了候选池。
	//
	// weightTable 已按「前缀长度降序」排好，命中第一个即可。
	for _, e := range weightTable {
		// 只要「更宽的网段」（前缀更短）且真的包含这个 IP
		if e.ones >= ones {
			continue
		}
		// 用起点 + 前缀长度判断覆盖关系（避免每次 Contains 分配）
		mask := ^uint32(0) << uint(32-e.ones)
		if binary.BigEndian.Uint32(ip.To4())&mask != e.base&mask {
			continue
		}
		return e.weight
	}
	return DefaultCIDRWeight
}

// normalizeCIDR 去掉多余空白并统一成 `a.b.c.d/n` 形式。
func normalizeCIDR(cidr string) string {
	c := strings.TrimSpace(cidr)
	_, ipnet, err := net.ParseCIDR(c)
	if err != nil {
		return c
	}
	ones, _ := ipnet.Mask.Size()
	return fmt.Sprintf("%s/%d", ipnet.IP.String(), ones)
}

// cidrSize 返回网段内的 IP 数量。
func cidrSize(cidr string) uint64 {
	_, ipnet, err := net.ParseCIDR(normalizeCIDR(cidr))
	if err != nil {
		return 0
	}
	ones, bits := ipnet.Mask.Size()
	if bits == 0 {
		return 0
	}
	hostBits := bits - ones
	if hostBits >= 63 {
		return ^uint64(0)
	}
	return uint64(1) << uint(hostBits)
}

// SampleOptions 是采样参数。
type SampleOptions struct {
	// Count 是期望采到的 IP 总数
	Count int
	// CIDRs 覆盖默认网段列表（空表示用内置网段）
	CIDRs []string
	// Seed 为 0 表示用密码学随机
	Seed int64
	// Neutral 为 true 时忽略权重、按网段大小等比采样（只保留权重 0 的不可达段）
	Neutral bool
	// Family 是**已解析完**的地址族："v4" / "v6" / "both"。
	// 空串等价 "v4" —— 保持旧调用方（与既有测试）的默认行为不变。
	Family string
	// ExtraIPv6CIDRs 是运行期从域名 AAAA 发现的活跃 48 位前缀。
	// 对照 CLI 的 extraWeights：静态表会漂移，用户自己域名的 AAAA 永远指向
	// 当下真正在用的段，有它兜底，静态表过期也不会让 v6 采样变成 0 候选。
	ExtraIPv6CIDRs []string
	// Adaptive 非 nil 时启用网络档案的 /24 探索/利用采样；nil 保留现有采样语义。
	Adaptive *AdaptiveSamplingOptions
	// ProfileID 是 IPv4 档案 ID；ProfileIDV6 是 IPv6 档案 ID。
	//
	// 档案 ID 由「运营商 + 地址族 + …」哈希得到，两族天然不同 ——
	// 采样必须按族查各自的观测，只给一个 ID 时 v6 的历史要么查不到、
	// 要么错查成 v4 的（对照 CLI 的 adaptivePool().options.profileIds）。
	ProfileID    string
	ProfileIDV6  string
	Observations []PrefixObservation
}

// familyIncludesV6 判断地址族是否包含 IPv6（空串 = 仅 IPv4，保持旧行为）。
func familyIncludesV6(family string) bool { return family == "v6" || family == "both" }

// isIPv6CIDR 判断网段字符串是否属于 IPv6（IPv6 地址里有多个冒号，不会与 IPv4 混淆）。
func isIPv6CIDR(cidr string) bool { return strings.Contains(cidr, ":") }

// resolveIPv6Pool 对照 CLI 的 splitByWeight(v6)：把输入里的 v6 段**收窄到活跃的 48 位前缀**。
//
// 为什么要收窄：官方公布的聚合段只是「分配」不是「在用」，实测随机抽 48 位前缀
// 0/18 全超时。整段参与采样等于把预算全烧在死地址上。
//
// 规则（与 CLI 一致）：
//  1. 输入段本身被某个活跃前缀覆盖 → 原样保留（用户给了更细的段就尊重他）
//  2. 否则把落在输入段**内部**的活跃前缀收进来
//  3. 都没有 → 整段丢弃
func resolveIPv6Pool(pool []string, extra []string) []string {
	active := make([]string, 0, len(ipv6PrefixWeights)+len(extra))
	seen := map[string]bool{}
	for _, p := range IPv6ActivePrefixes() {
		if !seen[p] {
			seen[p] = true
			active = append(active, p)
		}
	}
	for _, p := range extra {
		if !isIPv6CIDR(p) {
			continue
		}
		n := normalizeCIDR(p)
		if !seen[n] {
			seen[n] = true
			active = append(active, n)
		}
	}
	if len(active) == 0 {
		return nil
	}

	out := make([]string, 0, len(pool))
	added := map[string]bool{}
	add := func(s string) {
		if !added[s] {
			added[s] = true
			out = append(out, s)
		}
	}
	for _, c := range pool {
		if !isIPv6CIDR(c) {
			add(c)
			continue
		}
		normalized := normalizeCIDR(c)
		cNet, cOnes, err := parseCIDRParts(normalized)
		if err != nil {
			continue
		}
		// 规则 1：有活跃前缀覆盖它 → 原样保留
		covered := false
		for _, p := range active {
			aNet, aOnes, err := parseCIDRParts(p)
			if err != nil {
				continue
			}
			if aOnes <= cOnes && aNet.Contains(cNet.IP) {
				covered = true
				break
			}
		}
		if covered {
			add(normalized)
			continue
		}
		// 规则 2：把落在它内部的活跃前缀收进来
		for _, p := range active {
			aNet, aOnes, err := parseCIDRParts(p)
			if err != nil {
				continue
			}
			if aOnes >= cOnes && cNet.Contains(aNet.IP) {
				add(p)
			}
		}
	}
	return out
}

// parseCIDRParts 解析出网段与前缀长度（避免调用点重复写 ParseCIDR + Mask.Size）。
func parseCIDRParts(cidr string) (*net.IPNet, int, error) {
	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil, 0, err
	}
	ones, _ := ipnet.Mask.Size()
	return ipnet, ones, nil
}

// SampleCandidates 从 Cloudflare 网段里加权采样候选 IP。
//
// ## 分配算法
//
// 每个网段的预算 = `总预算 × (size × weight) / Σ(size × weight)`
//
// 用「最大余数法」把小数预算分配成整数，保证总数正好等于 Count，
// 且每个有权重的网段至少拿到 1 个（否则高权重的小网段会被大网段挤掉）。
//
// ## 分族预算（对照 CLI 的 expandCidrs）
//
// 两族都有可用段时**各拿 round(Count/2)**：v6 段的容量是 2^80、v4 的 /24 只有 254，
// 共用一个加权池会让容量大的一方吃掉几乎全部候选。
func SampleCandidates(opt SampleOptions) []string {
	if opt.Adaptive != nil {
		return SampleAdaptiveCandidates(opt)
	}
	if opt.Count <= 0 {
		opt.Count = 500
	}

	includeV6 := familyIncludesV6(opt.Family)
	// 默认池按族裁剪：只给 v6 时**不能**把 IPv4 官方段塞进来，
	// 否则「仅 IPv6」会静默产出一半 IPv4 候选。
	includeV4 := opt.Family != "v6"
	pool := opt.CIDRs
	if len(pool) == 0 {
		switch {
		case includeV6 && includeV4:
			pool = append(append([]string{}, BuiltinIPv4CIDRs...), IPv6ActivePrefixes()...)
		case includeV6:
			pool = IPv6ActivePrefixes()
		default:
			pool = BuiltinIPv4CIDRs
		}
	}

	v4Pool := make([]string, 0, len(pool))
	v6Pool := make([]string, 0, len(pool))
	for _, c := range pool {
		if isIPv6CIDR(c) {
			if includeV6 {
				v6Pool = append(v6Pool, c)
			}
		} else if includeV4 {
			v4Pool = append(v4Pool, c)
		}
	}
	if includeV6 {
		v6Pool = resolveIPv6Pool(v6Pool, opt.ExtraIPv6CIDRs)
	}

	switch {
	case len(v4Pool) == 0 && len(v6Pool) == 0:
		return []string{}
	case len(v6Pool) == 0:
		return sampleWeighted(v4Pool, opt.Count, opt)
	case len(v4Pool) == 0:
		return sampleWeighted(v6Pool, opt.Count, opt)
	}
	half := (opt.Count + 1) / 2 // 与 CLI 的 Math.round(count/2) 一致
	return append(sampleWeighted(v4Pool, half, opt), sampleWeighted(v6Pool, half, opt)...)
}

// sampleWeighted 对单一地址族按「大小 × 权重」分配预算并采样。
func sampleWeighted(pool []string, count int, opt SampleOptions) []string {
	type seg struct {
		cidr   string
		weight float64
		size   uint64
		budget float64
		alloc  int
	}

	segs := make([]seg, 0, len(pool))
	var totalWeight float64
	for _, c := range pool {
		w := cidrWeightForWithExtra(c, opt.Neutral, opt.ExtraIPv6CIDRs)
		if w <= 0 {
			continue // 权重 0 的网段完全不采样
		}
		sz := cidrSize(c)
		if sz == 0 {
			continue
		}
		segs = append(segs, seg{cidr: c, weight: w, size: sz})
		// 用浮点算 size×weight；size 可能很大，先归一化避免溢出
		totalWeight += float64(sz) * w
	}
	if len(segs) == 0 || totalWeight <= 0 {
		return []string{}
	}

	// 第一轮：按比例分配整数部分
	assigned := 0
	for i := range segs {
		segs[i].budget = float64(count) * (float64(segs[i].size) * segs[i].weight) / totalWeight
		segs[i].alloc = int(segs[i].budget)
		if segs[i].alloc < 1 {
			segs[i].alloc = 1 // 至少 1 个
		}
		if uint64(segs[i].alloc) > segs[i].size {
			segs[i].alloc = int(segs[i].size)
		}
		assigned += segs[i].alloc
	}

	// 第二轮：用最大余数法补齐差额
	if assigned < count {
		type rem struct {
			idx int
			r   float64
		}
		rems := make([]rem, 0, len(segs))
		for i := range segs {
			rems = append(rems, rem{idx: i, r: segs[i].budget - float64(int(segs[i].budget))})
		}
		sort.Slice(rems, func(a, b int) bool { return rems[a].r > rems[b].r })

		for assigned < count {
			progressed := false
			for _, r := range rems {
				if assigned >= count {
					break
				}
				i := r.idx
				if uint64(segs[i].alloc) < segs[i].size {
					segs[i].alloc++
					assigned++
					progressed = true
				}
			}
			if !progressed {
				break // 所有网段都采满了
			}
		}
	}

	// 逐段随机取 IP（去重）
	seen := make(map[string]struct{}, count)
	out := make([]string, 0, count)
	for _, sg := range segs {
		for _, ip := range sampleFromCIDR(sg.cidr, sg.alloc, opt.Seed) {
			if _, dup := seen[ip]; dup {
				continue
			}
			seen[ip] = struct{}{}
			out = append(out, ip)
			if len(out) >= count {
				return out
			}
		}
	}
	return out
}

// sampleFromCIDR 在网段内随机取 n 个不重复的 IP。
//
// 不生成整段列表（/13 有 50 万个地址，展开会吃掉几十 MB 内存），
// 而是随机生成索引后去重。
func sampleFromCIDR(cidr string, n int, seed int64) []string {
	_, ipnet, err := net.ParseCIDR(normalizeCIDR(cidr))
	if err != nil || n <= 0 {
		return nil
	}
	ones, bits := ipnet.Mask.Size()
	hostBits := bits - ones
	if hostBits <= 0 {
		return []string{ipnet.IP.String()}
	}

	// ---- IPv6：活跃段是 /48 = 2^80 个地址，只能随机取址，绝不能枚举 ----
	// （对照 CLI 的 expandCidrs 大桶分支：枚举会直接把进程撑到 OOM）
	if bits == 128 {
		return sampleFromCIDRv6(ipnet, n, seed, hostBits)
	}

	base := binary.BigEndian.Uint32(ipnet.IP.To4())
	maxHosts := uint64(1) << uint(hostBits)
	if maxHosts > uint64(n)*4 && hostBits >= 8 {
		// 跳过网络地址与广播地址（.0 与 .255 通常不可用）
		maxHosts -= 2
	}

	if uint64(n) > maxHosts {
		n = int(maxHosts)
	}

	seen := make(map[uint32]struct{}, n)
	out := make([]string, 0, n)
	attempts := 0
	maxAttempts := n*10 + 100

	for len(out) < n && attempts < maxAttempts {
		attempts++
		var offset uint64
		if seed != 0 {
			// 确定性采样（测试用）
			offset = uint64(seed+int64(attempts)*7919) % maxHosts
		} else {
			r, err := rand.Int(rand.Reader, big.NewInt(int64(maxHosts)))
			if err != nil {
				continue
			}
			offset = r.Uint64()
		}
		// +1 跳过网络地址
		addr := base + uint32(offset) + 1
		if _, dup := seen[addr]; dup {
			continue
		}
		seen[addr] = struct{}{}
		ip := make(net.IP, 4)
		binary.BigEndian.PutUint32(ip, addr)
		out = append(out, ip.String())
	}
	return out
}

// sampleFromCIDRv6 在 IPv6 网段内随机取 n 个不重复的地址。
//
// ## 为什么不能像 IPv4 那样「偏移取模」
//
// IPv4 的确定性偏移是 `(seed + attempts*7919) % maxHosts`，
// 而 /48 的 maxHosts 是 2^80 —— 取模等于没取，
// 所有样本会全部挤在网络地址附近（同一个 /64 里）。
// 这里改成用 seeded PRNG 拼出 hostBits 位再取模，样本才能铺满整个前缀。
//
// ## 为什么不减 2 跳过「网络地址 / 广播地址」
//
// 那是 IPv4 的 /31 /32 特例；IPv6 没有广播地址，
// 唯一要避开的是每个 /64 的子网路由器任播地址（全 0 接口标识）——
// 随机取址撞上它的概率是 1/2^64，不值得为此加分支。
func sampleFromCIDRv6(ipnet *net.IPNet, n int, seed int64, hostBits int) []string {
	span := new(big.Int).Lsh(big.NewInt(1), uint(hostBits))
	base := new(big.Int).SetBytes(ipnet.IP)

	var rng *mathrand.Rand
	if seed != 0 {
		rng = mathrand.New(mathrand.NewSource(seed))
	}

	seen := make(map[string]struct{}, n)
	out := make([]string, 0, n)
	attempts := 0
	maxAttempts := n*10 + 100
	for len(out) < n && attempts < maxAttempts {
		attempts++
		offset := new(big.Int)
		if rng != nil {
			// 确定性采样：每次拼 30 位，直到凑够 hostBits 位
			for produced := 0; produced < hostBits; produced += 30 {
				offset.Lsh(offset, 30)
				offset.Or(offset, big.NewInt(int64(rng.Intn(1<<30))))
			}
			offset.Mod(offset, span)
		} else {
			r, err := rand.Int(rand.Reader, span)
			if err != nil {
				continue
			}
			offset = r
		}
		// 网络地址的主机位全 0，直接加偏移不会越出前缀
		addr := new(big.Int).Add(base, offset)
		buf := make([]byte, net.IPv6len)
		addr.FillBytes(buf)
		key := net.IP(buf).String()
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

// ParseCandidateList 清洗用户提供的候选列表。
//
// 必须容错以下全部形态（AGENTS.md 铁律 6）：
//
//	1.2.3.4
//	1.2.3.4:443
//	1.2.3.4:443#备注
//	[2606:4700::1]:443#备注
//	host.example.com          （优选域名）
//	result.csv 原文           （CloudflareSpeedTest 输出）
//
// 清洗逻辑集中在这里，禁止在别处重复实现。
func ParseCandidateList(raw string) []string {
	out := make([]string, 0, 64)
	seen := make(map[string]struct{}, 64)

	add := func(ip string) {
		ip = strings.TrimSpace(ip)
		if ip == "" {
			return
		}
		if _, dup := seen[ip]; dup {
			return
		}
		seen[ip] = struct{}{}
		out = append(out, ip)
	}

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// CSV 表头
		if strings.HasPrefix(strings.ToLower(line), "ip") &&
			(strings.Contains(line, ",") || strings.Contains(line, "地址")) {
			continue
		}

		// CSV 行：取第一列
		fields := strings.FieldsFunc(line, func(r rune) bool {
			return r == ',' || r == '\t' || r == ' ' || r == ';'
		})
		if len(fields) == 0 {
			continue
		}
		token := fields[0]

		// 去掉 #备注
		if idx := strings.Index(token, "#"); idx >= 0 {
			token = token[:idx]
		}
		if token == "" {
			continue
		}

		// [IPv6]:port
		if strings.HasPrefix(token, "[") {
			if end := strings.Index(token, "]"); end > 0 {
				host := token[1:end]
				if net.ParseIP(host) != nil {
					add(host)
					continue
				}
			}
			continue
		}

		// IP:port —— 但要避免把 IPv6（含多个冒号）误拆
		if strings.Count(token, ":") == 1 {
			host, port, ok := strings.Cut(token, ":")
			if ok && isAllDigits(port) && net.ParseIP(host) != nil {
				add(host)
				continue
			}
		}

		// 裸 IPv6
		if net.ParseIP(token) != nil {
			add(token)
			continue
		}

		// 域名：直接保留（优选域名也是合法候选）
		//
		// ⚠️ 但「纯数字点分」的输入必须先当 IP 校验过。
		// `999.999.999.999` 通过了 isHostname（每段都是数字、长度合法），
		// 于是被当成域名收进来 —— 实际是无效地址，采进候选只会白占探测额度。
		// 规则：四段全数字 → 只能是合法 IPv4，否则丢弃。
		if looksLikeIPv4(token) {
			continue // 走到这里说明 parse 没过，是无效 IP，丢弃
		}
		if isHostname(token) {
			add(token)
		}
	}
	return out
}

// looksLikeIPv4 判断输入是不是「点分四段纯数字」形态。
//
// 这种形态只可能是 IPv4 字面量（域名不能全是数字段，
// 且顶级域不会是纯数字），所以它必须通过 net.ParseIP 才算合法。
func looksLikeIPv4(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return false
	}
	for _, p := range parts {
		if !isAllDigits(p) || p == "" || len(p) > 3 {
			return false
		}
	}
	return true
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// isHostname 粗判是否是合法域名。
func isHostname(s string) bool {
	if len(s) == 0 || len(s) > 253 {
		return false
	}
	labels := strings.Split(s, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if l == "" || len(l) > 63 {
			return false
		}
		for i, c := range l {
			ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-'
			if !ok {
				return false
			}
			if c == '-' && (i == 0 || i == len(l)-1) {
				return false
			}
		}
	}
	return true
}

// FormatHost 返回可安全拼接端口的主机部分。
//
// ## 为什么 IPv6 必须加方括号
//
// 数据面 sub-engine.ts 的解析器按冒号数量分流：
//
//	[2606:4700::1]:443  → 方括号形式 → host=2606:4700::1, port=443 ✓
//	2606:4700::1:443    → 冒号数 > 1 → 整个串当成 IPv6 地址
//	                      → host=2606:4700::1:443, port=默认 ✗ IP 错了
//
// 即裸 IPv6 带端口会被误解析成「一个更长的 IPv6 地址」，
// 订阅里就会指向一个不存在的地址。
// AGENTS.md 铁律 6 也要求解析器兼容 `[IPv6]:Port#备注` —— 产出方必须与之一致。
//
// familyOf 返回地址族：`v4` / `v6`（按字面量判，含冒号 = IPv6）。
//
// 对照 CLI 的 scan.ts `familyTag()` —— 备注里的 `IPv4_` / `IPv6_` 前缀
// 与 Entry.Family 都由它推导，两处永远一致。
func FamilyOf(ip string) string {
	if strings.Contains(ip, ":") {
		return "v6"
	}
	return "v4"
}

// 对应 CLI 版 packages/cli/src/scan/scan.ts 的 formatHost()。
func FormatHost(ip string) string {
	if strings.Contains(ip, ":") {
		return "[" + ip + "]"
	}
	return ip
}
