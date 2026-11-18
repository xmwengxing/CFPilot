package mesh

import "testing"

// H3-2 质量加权边权。
//
// 两条硬性质：
//  1. 缺质量样本时必须**逐字节等价**于旧公式 rtt + loss*500 + relay_penalty，
//     否则升级公式反而让旧边/刚建链的边变贵，选路行为会莫名漂移；
//  2. rtt_min 要夹紧到当前 RTT，样本回退时不能让 variance 变负，
//     否则丢包边可能被算得比直连还便宜。
func TestEdgeCostMissingQualityEqualsLegacy(t *testing.T) {
	direct := PathID{Direct: true, Peer: nodeID(1)}
	legacy := &PathCandidate{Path: direct, RTTMS: 42, LossRate: 0.25}
	want := 42.0 + 0.25*LossWeight // 无中继惩罚

	if got := legacy.Score(); got != want {
		t.Errorf("缺质量样本时 Score = %v, 期望旧公式 %v", got, want)
	}
}

func TestEdgeCostQualityWeights(t *testing.T) {
	direct := PathID{Direct: true, Peer: nodeID(1)}
	rttMin := uint32(30)
	jitter := uint32(5)
	c := &PathCandidate{Path: direct, RTTMS: 42, LossRate: 0.25, RTTMinMS: &rttMin, JitterMS: &jitter}

	// 1.0*30 + 1.5*(42-30) + 2.0*5 + 0.25*500
	want := WRttMin*30 + WRttVar*(42-30) + WJitter*5 + 0.25*LossWeight
	if got := c.Score(); got != want {
		t.Errorf("Score = %v, 期望 %v", got, want)
	}
}

func TestEdgeCostRTTMinClamped(t *testing.T) {
	direct := PathID{Direct: true, Peer: nodeID(1)}
	// 声明值 50 大于当前 RTT 42（样本回退）：variance 必须夹到 0
	rttMin := uint32(50)
	c := &PathCandidate{Path: direct, RTTMS: 42, LossRate: 0, RTTMinMS: &rttMin}
	if got := c.Score(); got != 42 {
		t.Errorf("Score = %v, 期望 42（variance 不得为负）", got)
	}
}

func TestRelayPenaltyPerHop(t *testing.T) {
	direct := PathID{Direct: true, Peer: nodeID(1)}
	relay := PathID{Direct: false, Peer: nodeID(2)}
	a := &PathCandidate{Path: direct, RTTMS: 40}
	b := &PathCandidate{Path: relay, RTTMS: 40}
	if got := b.Score() - a.Score(); got != RelayPenaltyMS {
		t.Errorf("中继惩罚 = %v, 期望每跳 %v", got, RelayPenaltyMS)
	}
}

// 质量样本必须真的改变排序：30% 丢包 + 大抖动的边应让位给稳定边。
func TestQualityChangesRanking(t *testing.T) {
	direct := PathID{Direct: true, Peer: nodeID(1)}
	relay := PathID{Direct: false, Peer: nodeID(2)}

	lowRTTBadQuality := &PathCandidate{
		Path: relay, RTTMS: 40, LossRate: 0.3,
		RTTMinMS: ptrU32(20), JitterMS: ptrU32(30),
	}
	// 40-20=20 方差 + 60 抖动：边权 = 20 + 30 + 60 + 150 + 15 = 275
	stable := &PathCandidate{Path: direct, RTTMS: 120, LossRate: 0.0}
	if stable.Score() >= lowRTTBadQuality.Score() {
		t.Errorf("稳定边(%v)应优于低延迟但高抖动丢包的边(%v)",
			stable.Score(), lowRTTBadQuality.Score())
	}
}

func ptrU32(v uint32) *uint32 { return &v }
