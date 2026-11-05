package scan

import "testing"

// 两轮测速「粗筛 → 精测」的选人逻辑。
// 对照 CLI packages/cli/test/two-stage-speed.test.ts 的 rankByCoarseSpeed，
// 两边必须对同一组输入给出同一组精测候选（AGENTS.md §2.2）。

func wsOf(ip string) WSResult { return WSResult{IP: ip, OK: true} }

func ipsOf(items []WSResult) []string {
	out := make([]string, 0, len(items))
	for _, r := range items {
		out = append(out, r.IP)
	}
	return out
}

func assertIPs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("条数不符：got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 条不符：got %v, want %v", i, got, want)
		}
	}
}

func TestSelectForFineTestOrdersByCoarseSpeed(t *testing.T) {
	items := []WSResult{wsOf("104.16.0.1"), wsOf("172.66.0.1"), wsOf("188.114.1.1")}
	coarse := map[string]float64{
		"104.16.0.1":  0.2,
		"172.66.0.1":  2.5,
		"188.114.1.1": 1.1,
	}
	// 粗测值只用于排序：函数返回的仍是 WSResult（不含速度），
	// 结果速度必须由后面的精测给出。
	got := selectForFineTest(items, coarse, 3)
	assertIPs(t, ipsOf(got), []string{"172.66.0.1", "188.114.1.1", "104.16.0.1"})
}

func TestSelectForFineTestAllCoarseFailedFallsBack(t *testing.T) {
	// 粗测全失败 / 未测：稳定排序保持阶段二的 101 延迟顺序；
	// 候选不足上限时整批返回（两端都显式短路，不进网段轮流）。
	items := []WSResult{
		wsOf("104.16.0.1"), wsOf("104.16.0.2"), wsOf("172.66.0.1"),
	}
	got := selectForFineTest(items, map[string]float64{}, 3)
	assertIPs(t, ipsOf(got), []string{"104.16.0.1", "104.16.0.2", "172.66.0.1"})
}

func TestSelectForFineTestUntestedRankLast(t *testing.T) {
	items := []WSResult{wsOf("104.16.0.1"), wsOf("172.66.0.1")}
	coarse := map[string]float64{"172.66.0.1": 1.0}
	got := selectForFineTest(items, coarse, 2)
	assertIPs(t, ipsOf(got), []string{"172.66.0.1", "104.16.0.1"})
}

func TestSelectForFineTestKeepsSubnetDiversity(t *testing.T) {
	// 同一 /16 的四条粗测最快，直接切前 3 名会全落在这一段。
	items := []WSResult{
		wsOf("104.16.0.1"), wsOf("104.16.0.2"),
		wsOf("104.16.0.3"), wsOf("104.16.0.4"),
		wsOf("172.66.0.1"), wsOf("188.114.1.1"),
	}
	coarse := map[string]float64{
		"104.16.0.1": 9, "104.16.0.2": 8, "104.16.0.3": 7, "104.16.0.4": 6,
		"172.66.0.1": 2, "188.114.1.1": 1,
	}
	got := selectForFineTest(items, coarse, 3)
	assertIPs(t, ipsOf(got), []string{"104.16.0.1", "172.66.0.1", "188.114.1.1"})
}

func TestCoarseDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	// 零值必须保持旧行为：内核不擅自给所有调用方开启两轮测速。
	if o.TwoStageSpeed {
		t.Error("Options 零值不应开启两轮测速（由外壳显式开启）")
	}
	// 逐项对齐 CLI 的 COARSE_SPEED_DEFAULTS。
	checks := map[string][2]int{
		"CoarseSpeedLimit":  {o.CoarseSpeedLimit, defCoarseSpeedLimit},
		"CoarseDurationMs":  {o.CoarseDurationMs, defCoarseDurationMs},
		"CoarseConnections": {o.CoarseConnections, defCoarseConnections},
		"CoarseTimeoutMs":   {o.CoarseTimeoutMs, defCoarseTimeoutMs},
		"CoarseBudgetMs":    {o.CoarseBudgetMs, defCoarseBudgetMs},
	}
	for name, pair := range checks {
		if pair[0] != pair[1] {
			t.Errorf("%s 默认值应为 %d，实际 %d", name, pair[1], pair[0])
		}
	}
	if defCoarseSpeedLimit != 120 || defCoarseDurationMs != 1200 ||
		defCoarseConnections != 2 || defCoarseTimeoutMs != 3000 ||
		defCoarseBudgetMs != 240000 || defCoarseWarmupMs != 300 || defCoarseWindowMs != 300 {
		t.Error("粗筛默认参数与 CLI COARSE_SPEED_DEFAULTS 漂移，请同步修改两边")
	}
}
