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
	"104.16.0.0/13":   1.0, // 实测 8/12
	"104.24.0.0/14":   0.9, // 实测 7/12
	"103.21.244.0/22": 0.3, // 实测 3/12
	"103.31.4.0/22":   0.3, // 实测 3/12
	"190.93.240.0/20": 0.3, // 实测 3/12
	"188.114.96.0/20": 0.3, // 实测 3/12
	"141.101.64.0/18": 0.2, // 实测 2/12
	"162.158.0.0/16":  0.2, // 162.158.x.x 边缘节点，部分可用
	// 162.159.x.x 是管理/API 网段，多数 403，但少数可用（见文件头教训 1）
	"162.159.0.0/16": 0.05,
	"172.64.0.0/13":  0.1, // 实测 1/12

	// 实测 0/12 —— 不采样
	"173.245.48.0/20":  0,
	"103.22.200.0/22":  0,
	"108.162.192.0/18": 0,
	"197.234.240.0/22": 0,
	"198.41.128.0/17":  0,
	"131.0.72.0/22":    0,
}

// DefaultCIDRWeight 是未列入权重表的网段的默认权重（保守取中等偏低）。
const DefaultCIDRWeight = 0.2

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
	if w, ok := ipv4CidrWeights[normalized]; ok {
		return w
	}

	ip, ipnet, err := net.ParseCIDR(normalized)
	if err != nil {
		return DefaultCIDRWeight
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
	// CIDRs 覆盖默认网段列表（空表示用 BuiltinIPv4CIDRs）
	CIDRs []string
	// Seed 为 0 表示用密码学随机
	Seed int64
}

// SampleCandidates 从 Cloudflare 网段里加权采样候选 IP。
//
// ## 分配算法
//
// 每个网段的预算 = `总预算 × (size × weight) / Σ(size × weight)`
//
// 用「最大余数法」把小数预算分配成整数，保证总数正好等于 Count，
// 且每个有权重的网段至少拿到 1 个（否则高权重的小网段会被大网段挤掉）。
func SampleCandidates(opt SampleOptions) []string {
	pool := opt.CIDRs
	if len(pool) == 0 {
		pool = BuiltinIPv4CIDRs
	}
	if opt.Count <= 0 {
		opt.Count = 500
	}

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
		w := CIDRWeight(c)
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
		segs[i].budget = float64(opt.Count) * (float64(segs[i].size) * segs[i].weight) / totalWeight
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
	if assigned < opt.Count {
		type rem struct {
			idx int
			r   float64
		}
		rems := make([]rem, 0, len(segs))
		for i := range segs {
			rems = append(rems, rem{idx: i, r: segs[i].budget - float64(int(segs[i].budget))})
		}
		sort.Slice(rems, func(a, b int) bool { return rems[a].r > rems[b].r })

		for assigned < opt.Count {
			progressed := false
			for _, r := range rems {
				if assigned >= opt.Count {
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
	seen := make(map[string]struct{}, opt.Count)
	out := make([]string, 0, opt.Count)
	for _, sg := range segs {
		for _, ip := range sampleFromCIDR(sg.cidr, sg.alloc, opt.Seed) {
			if _, dup := seen[ip]; dup {
				continue
			}
			seen[ip] = struct{}{}
			out = append(out, ip)
			if len(out) >= opt.Count {
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
// 对应 CLI 版 packages/cli/src/scan/scan.ts 的 formatHost()。
func FormatHost(ip string) string {
	if strings.Contains(ip, ":") {
		return "[" + ip + "]"
	}
	return ip
}
