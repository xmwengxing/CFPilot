package scan

// 网段库、加权采样、候选解析的测试。
//
// 这些是「优选结果好不好」的根基：
//   - 权重表错了 → 一半候选来自 0% 可用网段
//   - 采样算法错了 → 高权重网段拿不到足够名额
//   - 候选解析错了 → 用户粘进来的列表被静默丢光

import (
	"net"
	"strings"
	"testing"
)

// ---------- 权重表 ----------

func TestCIDRWeightExact(t *testing.T) {
	cases := []struct {
		cidr string
		want float64
	}{
		{"104.16.0.0/13", 0.9},
		{"104.24.0.0/14", 0.95},
		{"172.64.0.0/13", 0.55},
		// 实测 0/12 的网段必须权重 0（完全不采样）
		{"173.245.48.0/20", 0},
		{"103.22.200.0/22", 0},
		{"108.162.192.0/18", 0},
		{"198.41.128.0/17", 0},
		{"131.0.72.0/22", 0},
	}
	for _, tc := range cases {
		if got := CIDRWeight(tc.cidr); got != tc.want {
			t.Errorf("CIDRWeight(%q) = %v，期望 %v", tc.cidr, got, tc.want)
		}
	}
}

// 162.159.0.0/16 不能是 0 —— 实测有可用 IP，压到 0 会错杀。
func TestManagementSubnetNotZero(t *testing.T) {
	w := CIDRWeight("162.159.0.0/16")
	if w <= 0 {
		t.Fatalf("162.159.0.0/16 权重不能为 0（实测有可用 IP，如 162.159.237.59 2.8MB/s），实际 %v", w)
	}
	if w > 0.2 {
		t.Errorf("162.159.0.0/16 应是很低的权重（多数 403），实际 %v", w)
	}
}

// 子网必须继承**最长（最具体）**父网段的权重。
//
// 这是修好一个真实缺陷后的回归测试：早前条件写成了
// `tOnes <= ones` 并 continue，把「前缀更短的父网段」当非法跳过了，
// 于是属于实测 0/12 网段的子网（如 198.41.130.0/24）回落成默认 0.2，
// 让本该完全不采样的网段漏进候选池。
func TestCIDRWeightLongestPrefix(t *testing.T) {
	// 关键回归：零权重网段的子网必须仍是 0
	if got := CIDRWeight("198.41.130.0/24"); got != 0 {
		t.Errorf("198.41.130.0/24 应继承 198.41.128.0/17 的 0（绝不能漏采），实际 %v", got)
	}
	if got := CIDRWeight("173.245.50.0/24"); got != 0 {
		t.Errorf("173.245.50.0/24 应继承 173.245.48.0/20 的 0，实际 %v", got)
	}

	// 精确命中必须用表里的值
	if got := CIDRWeight("162.159.0.0/16"); got != 0.05 {
		t.Errorf("精确命中 162.159.0.0/16 应为 0.05，实际 %v", got)
	}

	// 162.159.1.0/24 同时被 162.158.0.0/15（0.2）和 162.159.0.0/16（0.05）覆盖，
	// 应取更具体的 /16 → 0.05
	if got := CIDRWeight("162.159.1.0/24"); got != 0.05 {
		t.Errorf("162.159.1.0/24 应取最长前缀 162.159.0.0/16 的 0.05，实际 %v", got)
	}

	// 162.158.x.x 属于 /15 与 /16 两个 0.2 的网段，结果仍是 0.2
	if got := CIDRWeight("162.158.5.0/24"); got != 0.3 {
		t.Errorf("162.158.5.0/24 应为 0.3，实际 %v", got)
	}
}

// 完全陌生的网段用默认权重。
func TestCIDRWeightUnknown(t *testing.T) {
	if got := CIDRWeight("1.2.3.0/24"); got != DefaultCIDRWeight {
		t.Errorf("未知网段应为默认 %v，实际 %v", DefaultCIDRWeight, got)
	}
}

// ---------- 加权采样 ----------

// 采样总数要等于请求数。
func TestSampleCount(t *testing.T) {
	for _, n := range []int{10, 100, 500} {
		got := SampleCandidates(SampleOptions{Count: n})
		if len(got) != n {
			t.Errorf("Count=%d 时应采到 %d 个，实际 %d", n, n, len(got))
		}
	}
}

// 采样结果不该包含权重 0 网段的 IP。
func TestSampleExcludesZeroWeight(t *testing.T) {
	ips := SampleCandidates(SampleOptions{Count: 500})

	zeroNets := []string{
		"173.245.48.0/20",
		"103.22.200.0/22",
		"108.162.192.0/18",
		"197.234.240.0/22",
		"198.41.128.0/17",
		"131.0.72.0/22",
	}
	for _, ip := range ips {
		parsed := net.ParseIP(ip)
		for _, c := range zeroNets {
			_, n, err := net.ParseCIDR(c)
			if err != nil {
				continue
			}
			if n.Contains(parsed) {
				t.Errorf("采到了权重 0 网段的 IP：%s（属于 %s）", ip, c)
			}
		}
	}
}

// 高权重网段应拿到更多名额。
func TestSampleWeightedDistribution(t *testing.T) {
	ips := SampleCandidates(SampleOptions{Count: 1000})

	counts := map[string]int{}
	_, bigNet, _ := net.ParseCIDR("104.16.0.0/13")   // 权重 1.0
	_, smallNet, _ := net.ParseCIDR("172.64.0.0/13") // 权重 0.1

	for _, ip := range ips {
		p := net.ParseIP(ip)
		if bigNet.Contains(p) {
			counts["104.16"]++
		}
		if smallNet.Contains(p) {
			counts["172.64"]++
		}
	}

	if counts["104.16"] <= counts["172.64"] {
		t.Errorf("权重 1.0 的网段应比权重 0.1 的拿到更多名额：104.16=%d, 172.64=%d",
			counts["104.16"], counts["172.64"])
	}
	if counts["104.16"] == 0 {
		t.Error("104.16.0.0/13 应采到 IP")
	}
}

// 采样结果不能有重复。
func TestSampleNoDuplicates(t *testing.T) {
	ips := SampleCandidates(SampleOptions{Count: 500})
	seen := make(map[string]struct{}, len(ips))
	for _, ip := range ips {
		if _, dup := seen[ip]; dup {
			t.Errorf("重复 IP：%s", ip)
		}
		seen[ip] = struct{}{}
	}
}

// 所有采样结果必须是合法 IPv4。
func TestSampleValidIPv4(t *testing.T) {
	for _, ip := range SampleCandidates(SampleOptions{Count: 200}) {
		p := net.ParseIP(ip)
		if p == nil {
			t.Errorf("非法 IP：%q", ip)
			continue
		}
		if p.To4() == nil {
			t.Errorf("应为 IPv4：%q", ip)
		}
	}
}

// 确定性种子应产出相同结果（便于复现问题）。
func TestSampleDeterministicWithSeed(t *testing.T) {
	a := SampleCandidates(SampleOptions{Count: 50, Seed: 12345})
	b := SampleCandidates(SampleOptions{Count: 50, Seed: 12345})
	if len(a) != len(b) {
		t.Fatalf("长度不同：%d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Errorf("第 %d 个不同：%s vs %s", i, a[i], b[i])
		}
	}
}

// 自定义网段列表要生效。
func TestSampleCustomCIDRs(t *testing.T) {
	ips := SampleCandidates(SampleOptions{
		Count: 20,
		CIDRs: []string{"104.16.0.0/13"},
	})
	if len(ips) != 20 {
		t.Errorf("应采 20 个，实际 %d", len(ips))
	}
	_, n, _ := net.ParseCIDR("104.16.0.0/13")
	for _, ip := range ips {
		if !n.Contains(net.ParseIP(ip)) {
			t.Errorf("%s 不在 104.16.0.0/13 内", ip)
		}
	}
}

// ---------- 候选列表解析 ----------

// 铁律 6：必须容错全部形态。
func TestParseCandidateListAllForms(t *testing.T) {
	raw := strings.Join([]string{
		"1.2.3.4",               // 裸 IP
		"5.6.7.8:443",           // IP:Port
		"9.10.11.12:8443#东京",    // IP:Port#备注
		"[2606:4700::1]:443#备注", // [IPv6]:Port#备注
		"2606:4700::2",          // 裸 IPv6
		"cf.example.com",        // 优选域名
		"",                      // 空行
		"   ",                   // 空白行
	}, "\n")

	got := ParseCandidateList(raw)

	want := []string{
		"1.2.3.4",
		"5.6.7.8",
		"9.10.11.12",
		"2606:4700::1",
		"2606:4700::2",
		"cf.example.com",
	}
	if len(got) != len(want) {
		t.Fatalf("应解析出 %d 个，实际 %d：%v", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 个应为 %q，实际 %q", i, want[i], got[i])
		}
	}
}

// CloudflareSpeedTest 的 result.csv 原文要能直接粘进来。
func TestParseCandidateListCSV(t *testing.T) {
	csv := `IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s)
104.16.1.1,4,4,0.00,45.2,12.34
104.17.2.2,4,4,0.00,50.1,10.00
`
	got := ParseCandidateList(csv)
	if len(got) != 2 {
		t.Fatalf("应解析出 2 个 IP，实际 %d：%v", len(got), got)
	}
	if got[0] != "104.16.1.1" || got[1] != "104.17.2.2" {
		t.Errorf("解析结果不对：%v", got)
	}
}

// 英文表头也要能跳过。
func TestParseCandidateListCSVEnglish(t *testing.T) {
	csv := "IP Address,Sent,Received,Loss,Latency,Speed\n1.2.3.4,4,4,0,45,12\n"
	got := ParseCandidateList(csv)
	if len(got) != 1 || got[0] != "1.2.3.4" {
		t.Errorf("应只取到 1.2.3.4，实际 %v", got)
	}
}

// 去重。
func TestParseCandidateListDedup(t *testing.T) {
	got := ParseCandidateList("1.2.3.4\n1.2.3.4:443\n1.2.3.4#note\n")
	if len(got) != 1 {
		t.Errorf("重复项应合并为 1 个，实际 %d：%v", len(got), got)
	}
}

// 非法内容要被丢弃，不能产生垃圾候选。
func TestParseCandidateListRejectsGarbage(t *testing.T) {
	raw := strings.Join([]string{
		"not-a-host",
		"999.999.999.999",
		"!!!",
		"1.2.3.4", // 唯一合法的
	}, "\n")
	got := ParseCandidateList(raw)
	if len(got) != 1 || got[0] != "1.2.3.4" {
		t.Errorf("应只保留 1.2.3.4，实际 %v", got)
	}
}

// IPv6 里的冒号不能被误当成 port 分隔。
func TestParseCandidateListIPv6NotSplit(t *testing.T) {
	got := ParseCandidateList("2001:db8::1")
	if len(got) != 1 {
		t.Fatalf("应解析出 1 个，实际 %v", got)
	}
	if got[0] != "2001:db8::1" {
		t.Errorf("IPv6 不应被拆分，实际 %q", got[0])
	}
}

// 空输入返回空列表（不 panic）。
func TestParseCandidateListEmpty(t *testing.T) {
	for _, in := range []string{"", "\n\n\n", "   \n  \n"} {
		if got := ParseCandidateList(in); len(got) != 0 {
			t.Errorf("空输入应返回空列表，实际 %v", got)
		}
	}
}

// TestNeutralSampling 守护「中性采样」：忽略权重，只保留不可达段为 0。
func TestNeutralSampling(t *testing.T) {
	// 中性采样下 172.64 与 104.16 都是 /13，候选数应接近；
	// 加权采样下 104.16（0.9）应明显多于 172.64（0.55）。
	count := func(list []string, prefix string) int {
		n := 0
		for _, ip := range list {
			if strings.HasPrefix(ip, prefix) {
				n++
			}
		}
		return n
	}
	weighted := SampleCandidates(SampleOptions{Count: 400, Seed: 7})
	neutral := SampleCandidates(SampleOptions{Count: 400, Seed: 7, Neutral: true})
	if count(neutral, "172.64.") <= count(weighted, "172.64.") {
		t.Errorf("中性采样应让 172.64 拿到更多候选：加权=%d 中性=%d",
			count(weighted, "172.64."), count(neutral, "172.64."))
	}
	// 不可达段仍然要排除
	for _, ip := range neutral {
		if strings.HasPrefix(ip, "198.41.") || strings.HasPrefix(ip, "131.0.72.") {
			t.Fatalf("中性采样不应包含不可达网段：%s", ip)
		}
	}
}
