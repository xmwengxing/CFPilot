package mesh

import (
	"testing"
)

func nodeID(b byte) NodeID {
	var n NodeID
	n[0] = b
	return n
}

func TestPathScore(t *testing.T) {
	direct := PathID{Direct: true, Peer: nodeID(1)}
	relay := PathID{Direct: false, Peer: nodeID(2)}

	// score = rtt + loss*500 + relay_penalty
	c1 := &PathCandidate{Path: direct, RTTMS: 100, LossRate: 0.1}
	if got, want := c1.Score(), 100.0+0.1*500.0+0.0; got != want {
		t.Errorf("直连评分 = %v, 期望 %v", got, want)
	}
	c2 := &PathCandidate{Path: relay, RTTMS: 100, LossRate: 0.1}
	if got, want := c2.Score(), 100.0+0.1*500.0+RelayPenaltyMS; got != want {
		t.Errorf("中继评分 = %v, 期望 %v", got, want)
	}
	if c2.Score() <= c1.Score() {
		t.Error("相同 RTT/丢包下直连应优于中继（relay_penalty）")
	}
}

func TestPathInitialSelection(t *testing.T) {
	m := NewPathManager(DefaultPathConfig())
	dst := nodeID(9)
	m.NowMS = 1000
	direct := PathID{Direct: true, Peer: nodeID(1)}
	relay := PathID{Direct: false, Peer: nodeID(2)}
	m.SetCandidates(dst, []PathID{relay, direct})
	// 未验证前无可用候选
	if r := m.Reevaluate(dst); r != nil {
		t.Errorf("未验证前不应选路: %+v", r)
	}
	// 验证两个候选：直连慢、中继快
	m.ApplyMeasurement(dst, nodeID(1), 300, 0)
	m.ApplyMeasurement(dst, nodeID(2), 50, 0)
	r := m.Reevaluate(dst)
	if r == nil || r.Reason != "初始选路" {
		t.Fatalf("应初始选中继（更快）: %+v", r)
	}
	if !r.To.Direct && r.To.Peer == nodeID(2) {
		// 正确：中继（peer=2）
	} else {
		t.Errorf("初始路径应是中继 2，实际 %v", r.To)
	}
	active, ok := m.ActivePath(dst)
	if !ok || active != r.To {
		t.Errorf("ActivePath 未更新: %v vs %v", active, r.To)
	}
}

func TestPathHysteresis(t *testing.T) {
	m := NewPathManager(DefaultPathConfig())
	dst := nodeID(9)
	m.NowMS = 1000
	p1 := PathID{Direct: true, Peer: nodeID(1)}
	p2 := PathID{Direct: true, Peer: nodeID(2)}
	m.SetCandidates(dst, []PathID{p1, p2})
	m.ApplyMeasurement(dst, nodeID(1), 100, 0)
	m.ApplyMeasurement(dst, nodeID(2), 95, 0)
	m.Reevaluate(dst) // 初始选 p2（更快）
	// 强制当前为 p1，上次切换时间归零以避开冷却
	m.Active[dst] = p1
	m.Previous[dst] = p2
	m.LastSwitchMS[dst] = 0
	m.NowMS = 3000
	// p2=95 vs p1=100，优 5ms < 滞回 10ms → 不切
	if r := m.Reevaluate(dst); r != nil {
		t.Errorf("优 5ms 不足滞回 10ms，不应切换: %+v", r)
	}
	// p2 优 20ms → 应切
	m.ApplyMeasurement(dst, nodeID(2), 80, 0)
	r := m.Reevaluate(dst)
	if r == nil || r.Reason != "探测到更优路径" {
		t.Errorf("优 20ms 应切换: %+v", r)
	}
}

func TestPathCooldown(t *testing.T) {
	cfg := DefaultPathConfig()
	cfg.SwitchCooldownMS = 1000
	m := NewPathManager(cfg)
	dst := nodeID(9)
	m.NowMS = 1000
	p1 := PathID{Direct: true, Peer: nodeID(1)}
	p2 := PathID{Direct: true, Peer: nodeID(2)}
	p3 := PathID{Direct: true, Peer: nodeID(3)}
	m.SetCandidates(dst, []PathID{p1, p2, p3})
	m.ApplyMeasurement(dst, nodeID(1), 200, 0)
	m.ApplyMeasurement(dst, nodeID(2), 100, 0)
	m.ApplyMeasurement(dst, nodeID(3), 50, 0)
	m.Reevaluate(dst) // 初始选 p3
	m.Active[dst] = p1
	m.NowMS = 1500 // 距上次切换 500ms < cooldown 1000
	m.ApplyMeasurement(dst, nodeID(2), 10, 0)
	if r := m.Reevaluate(dst); r != nil {
		t.Errorf("冷却期内不应切换: %+v", r)
	}
	m.NowMS = 2100 // 距上次 1100ms > cooldown
	if r := m.Reevaluate(dst); r == nil {
		t.Error("冷却结束后应切换")
	}
}

func TestPathFailureRollback(t *testing.T) {
	m := NewPathManager(DefaultPathConfig())
	dst := nodeID(9)
	m.NowMS = 1000
	p1 := PathID{Direct: true, Peer: nodeID(1)}
	p2 := PathID{Direct: true, Peer: nodeID(2)}
	m.SetCandidates(dst, []PathID{p1, p2})
	m.ApplyMeasurement(dst, nodeID(1), 100, 0)
	m.ApplyMeasurement(dst, nodeID(2), 200, 0)
	m.Reevaluate(dst) // 初始选 p1
	m.Active[dst] = p1
	m.Previous[dst] = p2
	m.NowMS = 3000 // 过冷却
	// p1 失效 → 应回滚到 p2
	r := m.OnLinkLoss(dst, nodeID(1))
	if r == nil || r.Reason != "当前路径失效：回滚到上一路径" {
		t.Fatalf("应回滚到 p2: %+v", r)
	}
	active, _ := m.ActivePath(dst)
	if active.Peer != nodeID(2) {
		t.Errorf("回滚后激活路径应为 p2，实际 %v", active)
	}
	// p2 也失效 → 回滚目标不可用，选最优（但无可用候选则 nil）
	m.OnLinkLoss(dst, nodeID(2))
	if r := m.Reevaluate(dst); r != nil {
		t.Errorf("全部失效时不应有切换: %+v", r)
	}
}

func TestLossWeight(t *testing.T) {
	// 契约 §5.1：LOSS_WEIGHT = 500，即 1.0 丢包率折算 500ms
	if LossWeight != 500.0 {
		t.Errorf("LOSS_WEIGHT = %v, 期望 500", LossWeight)
	}
	if RelayPenaltyMS != 15.0 {
		t.Errorf("RELAY_PENALTY_MS = %v, 期望 15", RelayPenaltyMS)
	}
}
