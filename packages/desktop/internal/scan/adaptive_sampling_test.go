package scan

import (
	"math"
	"net"
	"reflect"
	"testing"
	"time"
)

func TestDynamicPrefixWeight(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	options := AdaptiveSamplingOptions{Now: now}
	good := PrefixObservation{SampleCount: 100, TCPAttempts: 100, TCPSuccess: 100, WSAttempts: 20, WSSuccess: 20, LastTestAt: now}
	bad := good
	bad.WSSuccess = 0
	if DynamicPrefixWeight(0.2, &good, options) <= 0.8 {
		t.Fatal("真实 WS 成功应提高利用权重")
	}
	if DynamicPrefixWeight(0.9, &bad, options) >= 0.2 {
		t.Fatal("WS 失败不能被 TCP 成功掩盖")
	}
	stale := bad
	stale.LastTestAt = now.Add(-70 * 24 * time.Hour)
	if DynamicPrefixWeight(0.9, &stale, options) <= DynamicPrefixWeight(0.9, &bad, options) {
		t.Fatal("旧失败记录应逐渐回归先验")
	}
	bad.WSSuccess = -100
	if w := DynamicPrefixWeight(0, &bad, options); w != 0 || math.IsNaN(w) {
		t.Fatalf("权重下限失效：%v", w)
	}
	if w := DynamicPrefixWeight(math.NaN(), nil, options); math.IsNaN(w) {
		t.Fatal("非法权重不能污染采样")
	}
}

func TestAdaptiveSamplingBudgetDiversityAndSeed(t *testing.T) {
	opt := SampleOptions{Count: 200, Seed: 12345, CIDRs: []string{"104.16.0.0/16", "104.16.0.0/17"}, Adaptive: &AdaptiveSamplingOptions{MaxPrefixShare: 0.02}}
	first := SampleCandidates(opt)
	if len(first) != opt.Count {
		t.Fatalf("预算未填满：%d", len(first))
	}
	if !reflect.DeepEqual(first, SampleCandidates(opt)) {
		t.Fatal("显式 seed 应可复现")
	}
	seen, counts := make(map[string]bool), make(map[string]int)
	for _, ip := range first {
		if seen[ip] || net.ParseIP(ip) == nil {
			t.Fatalf("重复或无效地址：%s", ip)
		}
		seen[ip] = true
		counts[IPv4Prefix24(ip)]++
		if counts[IPv4Prefix24(ip)] > 4 {
			t.Fatal("超过 /24 集中度上限")
		}
	}
}

func TestAdaptiveSamplingExploresZeroWeight(t *testing.T) {
	opt := SampleOptions{Count: 200, Seed: 19, CIDRs: []string{"104.16.0.0/24", "198.41.128.0/24"}, Adaptive: &AdaptiveSamplingOptions{ExplorationRatio: 1, MaxPrefixShare: 1}}
	counts := make(map[string]int)
	for _, ip := range SampleCandidates(opt) {
		counts[IPv4Prefix24(ip)]++
	}
	if counts["198.41.128.0/24"] < 50 {
		t.Fatalf("探索没有覆盖静态零权重桶：%v", counts)
	}
}

func TestAdaptiveSamplingUsesOnlyCurrentProfile(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	opt := SampleOptions{Count: 200, Seed: 42, ProfileID: "a", CIDRs: []string{"104.16.0.0/24", "104.16.1.0/24"}, Adaptive: &AdaptiveSamplingOptions{Now: now, MaxPrefixShare: 1, ExplorationRatio: 0.1}}
	baseline := SampleCandidates(opt)
	opt.Observations = []PrefixObservation{{ProfileID: "b", Prefix: "104.16.0.0/24", WSAttempts: 1000, WSSuccess: 0, LastTestAt: now}}
	if !reflect.DeepEqual(baseline, SampleCandidates(opt)) {
		t.Fatal("其它网络的历史改变了当前采样")
	}
	opt.Observations[0].ProfileID = "a"
	badCount := 0
	for _, ip := range SampleCandidates(opt) {
		if IPv4Prefix24(ip) == "104.16.0.0/24" {
			badCount++
		}
	}
	if badCount >= 50 {
		t.Fatalf("失败桶没有降权：%d", badCount)
	}
	opt.Neutral = true
	withHistory := SampleCandidates(opt)
	opt.Observations = nil
	if !reflect.DeepEqual(withHistory, SampleCandidates(opt)) {
		t.Fatal("中性采样不应应用学习历史")
	}
}

func TestAdaptiveSamplingTinyRangesAndSaturation(t *testing.T) {
	for _, cidrs := range [][]string{{"104.16.0.0/32"}, {"104.16.0.0/31"}, {"104.16.0.248/29"}, {"bad", "2001:db8::/32"}} {
		out := SampleCandidates(SampleOptions{Count: 500, CIDRs: cidrs, Seed: 1, Adaptive: &AdaptiveSamplingOptions{}})
		seen := make(map[string]bool)
		for _, ip := range out {
			inside := false
			for _, cidr := range cidrs {
				_, network, err := net.ParseCIDR(cidr)
				if err == nil && network.Contains(net.ParseIP(ip)) {
					inside = true
				}
			}
			if !inside || seen[ip] {
				t.Fatalf("越界或重复地址：%s (%v)", ip, cidrs)
			}
			seen[ip] = true
		}
		if len(out) > 8 {
			t.Fatalf("超出池容量：%v", out)
		}
	}
}

func TestAdaptiveZeroWeightExploitationExhaustion(t *testing.T) {
	out := SampleAdaptiveCandidates(SampleOptions{Count: 100, Seed: 9, CIDRs: []string{"198.41.128.0/24"}, Adaptive: &AdaptiveSamplingOptions{ExplorationRatio: 0.2, MaxPrefixShare: 1}})
	if len(out) != 20 {
		t.Fatalf("零权重桶只能消耗探索预算：%d", len(out))
	}
	out = SampleAdaptiveCandidates(SampleOptions{Count: 500, Seed: 9, CIDRs: []string{"104.16.1.0/24", "104.16.1.0/25", "104.16.1.128/25"}, Adaptive: &AdaptiveSamplingOptions{MaxPrefixShare: 1}})
	if len(out) != 254 {
		t.Fatalf("重叠网段容量错误：%d", len(out))
	}
}

func TestDynamicStageWeightHalfLife(t *testing.T) {
	now := time.Now().UTC()
	v := PrefixObservation{ProfileID: "a", Prefix: "104.16.1.0/24", Stage: "ws", Attempts: 10, Successes: 10, Failures: map[string]float64{}, UpdatedAt: now.Add(-time.Hour)}
	got := DynamicPrefixWeight(0.2, &v, AdaptiveSamplingOptions{Now: now, HalfLife: time.Hour})
	want := (0.2*2 + 5) / 7
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("未使用真实半衰期：%v / %v", got, want)
	}
	v.UpdatedAt = now.Add(time.Hour)
	if got = DynamicPrefixWeight(0.2, &v, AdaptiveSamplingOptions{Now: now}); got != 0.2 {
		t.Fatalf("未来统计不应参与利用：%v", got)
	}
}

func BenchmarkAdaptiveSamplingBuiltin(b *testing.B) {
	for i := 0; i < b.N; i++ {
		SampleCandidates(SampleOptions{Count: 500, Seed: 1, Adaptive: &AdaptiveSamplingOptions{}})
	}
}
