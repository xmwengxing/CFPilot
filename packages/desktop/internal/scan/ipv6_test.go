package scan

// IPv6 独立优选引擎的测试（对照 CLI 的 ipv6-sampling.test.ts / ipv6-env.test.ts）。
//
// 重点验证四件事：
//   - 权重表：活跃段 > 0、死段与未知段 == 0，且默认值与 IPv4 相反
//   - 采样：只落在活跃 48 位前缀内，分族预算不互相挤占
//   - 观测前缀：与 CLI 的 networkBucket() 逐字节一致（差一个 0 就永远查不到历史）
//   - 预检：三态齐全，且失败时**不产生任何观测**

import (
	"strings"
	"testing"
	"time"
)

func TestIPv6WeightTableMatchesCLI(t *testing.T) {
	// 活跃段（WS101 实测通过）
	for _, cidr := range []string{
		"2606:4700:3035::/48", "2606:4700:3037::/48", "2606:4700:3030::/48",
		"2606:4700:10::/48", "2606:4700:20::/48", "2a06:98c1:3100::/48",
		"2606:4700::/48", "2606:4700:1::/48",
	} {
		if w := CIDRWeight(cidr); w <= 0 {
			t.Errorf("%s 应为活跃段，实际权重 %v", cidr, w)
		}
	}
	// 死段（TCP/TLS 通但 WS101 回 403；或 TCP 层不通）
	for _, cidr := range []string{
		"2400:cb00:2048::/48", "2400:cb00:2049::/48",
		"2606:4700:50::/48", "2606:4700:58::/48", "2803:f800:50::/48", "2a06:98c1:50::/48",
	} {
		if w := CIDRWeight(cidr); w != 0 {
			t.Errorf("%s 实测不可用，权重应为 0，实际 %v", cidr, w)
		}
	}
	// 没实测过的一律不采（默认 0，与 IPv4 的 0.2 相反）
	if w := CIDRWeight("2606:4700:beef::/48"); w != 0 {
		t.Errorf("未知段默认权重应为 0，实际 %v", w)
	}
	// 公布聚合段本身不是「活跃段」（表里的条目都是 48 位前缀）
	if w := CIDRWeight("2606:4700::/32"); w != 0 {
		t.Errorf("聚合段权重应为 0，实际 %v", w)
	}
	// 128 位最长前缀匹配：活跃 /48 覆盖同段内的 /64 与 /128
	if CIDRWeight("2606:4700:3035:abcd::/64") != CIDRWeight("2606:4700:3035::/48") {
		t.Error("/64 应继承所属 /48 的权重")
	}
	// IPv4 行为保持不变
	if CIDRWeight("104.16.0.0/13") != 0.9 || CIDRWeight("1.2.3.0/24") != DefaultCIDRWeight {
		t.Error("IPv4 权重行为不应被 IPv6 改动影响")
	}
}

// IPv6Prefix48 必须与 CLI 的 networkBucket() 逐字节一致。
//
// ⚠️ 特别注意 `2606:4700::/48` 要输出成 `2606:4700:0::/48`（三组都写出来）——
// TS 侧用的是模板字符串，Go 若压缩掉那个 0，两端的观测键就永远对不上。
func TestIPv6Prefix48MatchesCLIFormat(t *testing.T) {
	cases := map[string]string{
		"2606:4700:0:0:0:0:6810:85e5": "2606:4700:0::/48",
		"2606:4700::":                 "2606:4700:0::/48",
		"2606:4700:3035::ac43:91f1":   "2606:4700:3035::/48",
		"2a06:98c1:3100:931e::1":      "2a06:98c1:3100::/48",
		"[2606:4700:3037::1]":         "2606:4700:3037::/48",
	}
	for input, want := range cases {
		if got := IPv6Prefix48(input); got != want {
			t.Errorf("IPv6Prefix48(%q) = %q，期望 %q", input, got, want)
		}
	}
	// 域名 / IPv4 不产生 v6 键
	for _, input := range []string{"host.example", "1.2.3.4", ""} {
		if got := IPv6Prefix48(input); got != "" {
			t.Errorf("IPv6Prefix48(%q) 应为空，实际 %q", input, got)
		}
	}
}

// 观测前缀：IPv4 → /24，IPv6 → /48，域名与非公网地址不进桶。
func TestObservationPrefixByFamily(t *testing.T) {
	if got := ObservationPrefix("104.16.1.2"); got != "104.16.1.0/24" {
		t.Errorf("IPv4 观测前缀不对：%q", got)
	}
	if got := ObservationPrefix("2606:4700:3035:abcd::1"); got != "2606:4700:3035::/48" {
		t.Errorf("IPv6 观测前缀不对：%q", got)
	}
	// 文档段 / Teredo / 链路本地 / 域名都不进桶
	for _, ip := range []string{"2001:db8::1", "2001::1", "fe80::1", "fd7a::1", "host.example", "bad"} {
		if got := ObservationPrefix(ip); got != "" {
			t.Errorf("%s 不应进入统计桶，实际 %q", ip, got)
		}
	}
}

func TestSampleCandidatesFamilySplit(t *testing.T) {
	// 只要 IPv4（空 Family 保持旧调用方语义）
	v4Only := SampleCandidates(SampleOptions{Count: 100, Seed: 7})
	if len(v4Only) == 0 {
		t.Fatal("默认应产出候选")
	}
	for _, ip := range v4Only {
		if strings.Contains(ip, ":") {
			t.Fatalf("默认不应产出 IPv6 候选：%s", ip)
		}
	}

	both := SampleCandidates(SampleOptions{Count: 100, Seed: 7, Family: "both"})
	var gotV4, gotV6 int
	for _, ip := range both {
		if strings.Contains(ip, ":") {
			gotV6++
		} else {
			gotV4++
		}
	}
	if gotV4 == 0 || gotV6 == 0 {
		t.Fatalf("both 应两族都有，实际 v4=%d v6=%d", gotV4, gotV6)
	}
	// 分族预算：两族都有时各拿 round(count/2)
	if diff := gotV4 - gotV6; diff > 1 || diff < -1 {
		t.Errorf("两族预算应各占一半，实际 v4=%d v6=%d", gotV4, gotV6)
	}

	v6Only := SampleCandidates(SampleOptions{Count: 60, Seed: 7, Family: "v6"})
	if len(v6Only) == 0 {
		t.Fatal("v6 模式应产出候选")
	}
	for _, ip := range v6Only {
		if !strings.Contains(ip, ":") {
			t.Fatalf("v6 模式不应产出 IPv4 候选：%s", ip)
		}
	}
}

// v6 候选必须**全部落在活跃 48 位前缀内**（在公布聚合段里盲采实测 0/18）。
func TestSampleCandidatesV6OnlyActivePrefixes(t *testing.T) {
	active := map[string]bool{}
	for _, p := range IPv6ActivePrefixes() {
		active[p] = true
	}
	if len(active) == 0 {
		t.Fatal("活跃前缀表不应为空")
	}
	out := SampleCandidates(SampleOptions{Count: 300, Seed: 11, Family: "v6"})
	if len(out) == 0 {
		t.Fatal("应产出候选")
	}
	for _, ip := range out {
		key := IPv6Prefix48(ip)
		if !active[key] {
			t.Errorf("候选 %s 落在非活跃前缀 %s 内", ip, key)
		}
	}
	// 候选互不重复
	seen := map[string]bool{}
	for _, ip := range out {
		if seen[ip] {
			t.Errorf("候选重复：%s", ip)
		}
		seen[ip] = true
	}
}

// 运行期从 AAAA 发现的前缀要参与采样（静态表漂移时的兜底）。
func TestSampleCandidatesExtraIPv6Prefixes(t *testing.T) {
	const extra = "2606:4700:beef::/48" // 静态表里没有的段
	out := SampleCandidates(SampleOptions{
		Count: 40, Seed: 5, Family: "v6",
		CIDRs:          []string{extra},
		ExtraIPv6CIDRs: []string{extra},
	})
	if len(out) == 0 {
		t.Fatal("AAAA 发现的前缀应能参与采样")
	}
	for _, ip := range out {
		if got := IPv6Prefix48(ip); got != extra {
			t.Errorf("候选 %s 应落在 %s，实际 %s", ip, extra, got)
		}
	}
	// 没有 extra 时同一个段采不出东西（未实测过的一律不采）
	if got := SampleCandidates(SampleOptions{Count: 40, Seed: 5, Family: "v6", CIDRs: []string{extra}}); len(got) != 0 {
		t.Errorf("未实测段不应产出候选，实际 %d 个", len(got))
	}
}

// 自适应路径：v6 按 48 位前缀建桶，且观测按前缀能查到。
func TestAdaptiveSampleV6Buckets(t *testing.T) {
	out := SampleCandidates(SampleOptions{
		Count: 60, Seed: 3, Family: "both",
		Adaptive:     &AdaptiveSamplingOptions{ExplorationRatio: 0.2},
		ProfileID:    "p-v4",
		ProfileIDV6:  "p-v6",
		Observations: []PrefixObservation{},
	})
	var gotV4, gotV6 int
	for _, ip := range out {
		if strings.Contains(ip, ":") {
			gotV6++
		} else {
			gotV4++
		}
	}
	if gotV4 == 0 || gotV6 == 0 {
		t.Fatalf("自适应模式下 both 应两族都有，实际 v4=%d v6=%d", gotV4, gotV6)
	}
	// 同种子可复现
	again := SampleCandidates(SampleOptions{
		Count: 60, Seed: 3, Family: "both",
		Adaptive:    &AdaptiveSamplingOptions{ExplorationRatio: 0.2},
		ProfileID:   "p-v4",
		ProfileIDV6: "p-v6",
	})
	if len(again) != len(out) {
		t.Fatalf("同种子应可复现：%d vs %d", len(out), len(again))
	}
	for i := range out {
		if out[i] != again[i] {
			t.Fatalf("同种子结果不一致：%s vs %s", out[i], again[i])
		}
	}
}

// 分族 + 族内按 48 位前缀轮流（对照 CLI 的 pickWithDiversity）。
func TestPickWithDiversityFamilyAndPrefix(t *testing.T) {
	mk := func(ips ...string) []Entry {
		out := make([]Entry, 0, len(ips))
		for _, ip := range ips {
			out = append(out, Entry{IP: ip})
		}
		return out
	}
	// 纯 IPv4：行为与旧实现一致（按 /16 轮流）
	v4 := mk("104.16.1.1", "104.16.1.2", "104.17.1.1", "104.17.1.2", "104.18.1.1")
	got := PickWithDiversity(v4, 3)
	if len(got) != 3 || got[0].IP != "104.16.1.1" || got[1].IP != "104.17.1.1" || got[2].IP != "104.18.1.1" {
		t.Fatalf("IPv4 轮流取法不对：%v", entryIPs(got))
	}

	// 两族混合：各取 round(top/2)
	mixed := mk("104.16.1.1", "104.17.1.1", "2606:4700:3035::1", "2606:4700:3030::1", "2606:4700:10::1")
	got = PickWithDiversity(mixed, 4)
	var c4, c6 int
	for _, e := range got {
		if strings.Contains(e.IP, ":") {
			c6++
		} else {
			c4++
		}
	}
	if c4 != 2 || c6 != 2 {
		t.Fatalf("混合时应各取一半，实际 v4=%d v6=%d：%v", c4, c6, entryIPs(got))
	}

	// 纯 IPv6：按 48 位前缀轮流，而不是整串各自成桶
	v6 := mk(
		"2606:4700:3035::1", "2606:4700:3035::2", "2606:4700:3035::3",
		"2606:4700:3030::1", "2606:4700:3030::2",
		"2a06:98c1:3100::1",
	)
	got = PickWithDiversity(v6, 4)
	if len(got) != 4 {
		t.Fatalf("应取 4 条，实际 %d", len(got))
	}
	// 轮流顺序：3035 → 3030 → 3100 → 3035
	want := []string{"2606:4700:3035::1", "2606:4700:3030::1", "2a06:98c1:3100::1", "2606:4700:3035::2"}
	for i, ip := range want {
		if got[i].IP != ip {
			t.Fatalf("IPv6 轮流顺序不对（第 %d 个应为 %s，实际 %s）：%v", i+1, ip, got[i].IP, entryIPs(got))
		}
	}
}

func entryIPs(entries []Entry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.IP)
	}
	return out
}

// 预检三态（探测点注入，不碰真实网络与真实路由表）。
func TestDetectIPv6EnvStates(t *testing.T) {
	origLocal, origRoute, origTCP := findGlobalIPv6Fn, probeRouteFn, tcpReachableFn
	defer func() {
		findGlobalIPv6Fn, probeRouteFn, tcpReachableFn = origLocal, origRoute, origTCP
	}()

	// 1) 没有公网地址
	findGlobalIPv6Fn = func() (string, string, bool) { return "", "", false }
	r := DetectIPv6Env([]string{"2606:4700:3035::1"}, 0)
	if r.Status != IPv6EnvNoAddress || r.CanaryTried != 0 {
		t.Fatalf("无地址时应 no-address 且不做金丝雀：%+v", r)
	}
	if !strings.Contains(r.Message, "当前网络环境不具备 IPv6 测速条件") {
		t.Errorf("提示语应包含固定前缀：%q", r.Message)
	}
	if len(r.Advice) == 0 {
		t.Error("应给出排查建议")
	}

	// 2) 有地址但没有默认路由
	findGlobalIPv6Fn = func() (string, string, bool) { return "240e:37c::1", "eth0", true }
	probeRouteFn = func(timeout time.Duration) *bool { f := false; return &f }
	r = DetectIPv6Env([]string{"2606:4700:3035::1"}, 0)
	if r.Status != IPv6EnvNoRoute || r.Address != "240e:37c::1" || r.CanaryTried != 0 {
		t.Fatalf("无路由时应 no-route 且不做金丝雀：%+v", r)
	}

	// 3) 路由判定失败（nil）不阻断，继续做金丝雀
	probeRouteFn = func(timeout time.Duration) *bool { return nil }
	tcpReachableFn = func(address string, port int, timeout time.Duration) bool { return false }
	r = DetectIPv6Env([]string{"2606:4700:3035::1", "2606:4700:3030::1"}, 0)
	if r.Status != IPv6EnvNoInternet || r.CanaryTried != 2 || r.CanaryOk != 0 {
		t.Fatalf("金丝雀全失败应 no-internet：%+v", r)
	}

	// 4) 金丝雀部分成功即放行
	tcpReachableFn = func(address string, port int, timeout time.Duration) bool {
		return strings.Contains(address, "3035")
	}
	r = DetectIPv6Env([]string{"2606:4700:3035::1", "2606:4700:3030::1"}, 0)
	if r.Status != IPv6EnvOK || r.CanaryOk != 1 {
		t.Fatalf("金丝雀部分成功应 ok：%+v", r)
	}

	// 5) 没有金丝雀时只用「地址 + 路由」判定
	r = DetectIPv6Env(nil, 0)
	if r.Status != IPv6EnvOK || r.CanaryTried != 0 || !strings.Contains(r.Message, "未做金丝雀探测") {
		t.Fatalf("无金丝雀时应按地址+路由判定：%+v", r)
	}
}
