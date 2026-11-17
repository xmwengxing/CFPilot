package mesh

import "testing"

func TestLossWindowRecordIfSent(t *testing.T) {
	w := NewLossWindow()
	// 同一 sentTotal 不记样本（record_if_sent 核心语义）
	if w.RecordIfSent(10, 5) != true {
		t.Error("首次 sentTotal 变化应记样本")
	}
	if w.RecordIfSent(10, 6) != false {
		t.Error("sentTotal 未变不应记样本")
	}
	if w.Samples() != 1 {
		t.Errorf("样本数 = %d, 期望 1", w.Samples())
	}
	// sentTotal 前进才记
	if !w.RecordIfSent(11, 6) {
		t.Error("sentTotal 前进应记样本")
	}
	if w.Samples() != 2 {
		t.Errorf("样本数 = %d, 期望 2", w.Samples())
	}
}

func TestLossWindowRate(t *testing.T) {
	w := NewLossWindow()
	// 样本不足返回 0
	w.Record(true)
	w.Record(false)
	if w.LossRate() != 0 {
		t.Errorf("样本不足应返回 0，实际 %v", w.LossRate())
	}
	// 再来 3 true + 1 false → 累计 6 样本：4 应答 2 未应答 → 33.3% 丢包
	for i := 0; i < 3; i++ {
		w.Record(true)
	}
	w.Record(false)
	if got := w.LossRate(); got < 0.33 || got > 0.34 {
		t.Errorf("丢包率 = %v, 期望 ~0.333", got)
	}
	// 窗口上界 20
	for i := 0; i < 100; i++ {
		w.Record(true)
	}
	if w.Samples() != lossWindowTicks {
		t.Errorf("窗口应封顶 %d，实际 %d", lossWindowTicks, w.Samples())
	}
}

func TestDegradePolicyToWSS(t *testing.T) {
	p := NewDegradePolicy()
	peer := nodeID(1)
	// 样本不足：不判
	for i := 0; i < 5; i++ {
		if d := p.Observe(peer, TransportUDP, 0.5, 3, 400); d.Kind != DecisionStay {
			t.Errorf("样本不足不应判，实际 %v", d)
		}
	}
	// 连续 3 窗丢包 > 20%
	for i := 0; i < 2; i++ {
		if d := p.Observe(peer, TransportUDP, 0.3, 10, 100); d.Kind != DecisionStay {
			t.Errorf("第 %d 窗不应切，实际 %v", i, d)
		}
	}
	d := p.Observe(peer, TransportUDP, 0.3, 10, 100)
	if d.Kind != DecisionToWSS {
		t.Errorf("连续 3 窗应降级，实际 %v", d)
	}
	// 切换后进入冷却：后续观测被忽略
	if d2 := p.Observe(peer, TransportUDP, 0.5, 10, 500); d2.Kind != DecisionStay {
		t.Errorf("冷却期内不应切，实际 %v", d2)
	}
}

func TestDegradePolicyToWSSRTT(t *testing.T) {
	p := NewDegradePolicy()
	peer := nodeID(1)
	// 丢包低但 RTT 高 → 也应降级
	for i := 0; i < 2; i++ {
		p.Observe(peer, TransportUDP, 0.05, 10, 400)
	}
	if d := p.Observe(peer, TransportUDP, 0.05, 10, 400); d.Kind != DecisionToWSS {
		t.Errorf("RTT>300ms 应降级，实际 %v", d)
	}
}

func TestDegradePolicyToUDP(t *testing.T) {
	p := NewDegradePolicy()
	peer := nodeID(1)
	// 先进入 WSS 档位并过冷却
	p.BeginCooldown(peer)
	for i := int(p.thresholds.CooldownTicks); i > 0; i-- {
		p.Observe(peer, TransportWSS, 0.2, 10, 200) // 消耗冷却
	}
	// 连续 3 窗：丢包<5% 且 RTT<=150ms
	for i := 0; i < 2; i++ {
		if d := p.Observe(peer, TransportWSS, 0.02, 10, 100); d.Kind != DecisionStay {
			t.Errorf("第 %d 窗不应切，实际 %v", i, d)
		}
	}
	if d := p.Observe(peer, TransportWSS, 0.02, 10, 100); d.Kind != DecisionToUDP {
		t.Errorf("连续 3 良好窗应回切，实际 %v", d)
	}
}

func TestDegradePolicyGoodRequiresBoth(t *testing.T) {
	p := NewDegradePolicy()
	peer := nodeID(1)
	p.BeginCooldown(peer)
	for i := int(p.thresholds.CooldownTicks); i > 0; i-- {
		p.Observe(peer, TransportWSS, 0.2, 10, 200)
	}
	// 丢包好但 RTT 差 → 不回切
	for i := 0; i < 5; i++ {
		if d := p.Observe(peer, TransportWSS, 0.02, 10, 200); d.Kind != DecisionStay {
			t.Errorf("RTT>150 不应回切，实际 %v", d)
		}
	}
}

func TestDegradeUdpHealthy(t *testing.T) {
	p := NewDegradePolicy()
	peer := nodeID(1)
	if p.UdpHealthy(peer) {
		t.Error("无样本时 UdpHealthy 应保守返回 false")
	}
	p.Observe(peer, TransportUDP, 0.02, 10, 50)
	if !p.UdpHealthy(peer) {
		t.Error("UDP 健康样本后 UdpHealthy 应为 true")
	}
	p.Observe(peer, TransportUDP, 0.5, 10, 400)
	if p.UdpHealthy(peer) {
		t.Error("UDP 差样本后 UdpHealthy 应为 false")
	}
}
