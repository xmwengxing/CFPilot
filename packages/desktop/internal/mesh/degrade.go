package mesh

import (
	"fmt"
	"sync"
)

// 降级/回切控制器（Phase 3b-2c 阶段 2，对齐 MobiHop node.rs:3091-3255 + router.rs:140-173）。
//
// 关键纪律：
//   - 每邻居独立 Counter{bad, good, cooldown, udp_ok}
//   - 200ms 测量 tick 维护 LossWindow，但**只在确实发出探针的 tick 记样本**（record_if_sent），
//     否则 1s 一探针被 200ms tick 算成 80% 丢包，<5% 回切判据永远不可达
//   - 1s 控制 tick 调 DegradePolicy.observe：样本 <5 不判；
//     UDP 连续 3 窗 (loss>20% 或 rtt>300ms) → ToWss；
//     WSS 连续 3 窗 (loss<5% 且 rtt≤150ms) → ToUdp；切换后冷却 10 窗

const (
	lossWindowTicks = 20
	lossMinSamples  = 5
)

// LossWindow 是 20 窗口的丢包统计（router.rs:130-174）。
type LossWindow struct {
	answered []bool // 是否收到应答
	lastSent uint64 // 上次记录的 sent_total（record_if_sent 门控）
}

func NewLossWindow() *LossWindow { return &LossWindow{} }

// Record 记录一个样本（answered = 是否收到 pong）。
func (w *LossWindow) Record(answered bool) {
	if len(w.answered) >= lossWindowTicks {
		w.answered = w.answered[1:]
	}
	w.answered = append(w.answered, answered)
}

// RecordIfSent 仅在 sentTotal 变化时记录一个样本（router.rs:152-159）。
// 返回是否真的记了样本。
func (w *LossWindow) RecordIfSent(sentTotal, pongTotal uint64) bool {
	if sentTotal == w.lastSent {
		return false
	}
	w.lastSent = sentTotal
	w.Record(pongTotal > 0)
	return true
}

func (w *LossWindow) Samples() uint32 { return uint32(len(w.answered)) }

// LossRate 返回 [0,1]；样本 <5 返回 0（不误报）。
func (w *LossWindow) LossRate() float64 {
	n := len(w.answered)
	if uint32(n) < lossMinSamples {
		return 0
	}
	got := 0
	for _, a := range w.answered {
		if a {
			got++
		}
	}
	return 1.0 - float64(got)/float64(n)
}

// TransportKind 是当前链路档位。
type TransportKind int

const (
	TransportUDP TransportKind = iota
	TransportWSS
)

// Decision 是 observe 的判定结果（node.rs:3111-3118）。
type Decision struct {
	Kind   DecisionKind // stay / to_wss / to_udp
	Reason string
}

type DecisionKind int

const (
	DecisionStay DecisionKind = iota
	DecisionToWSS
	DecisionToUDP
)

// degradeCounter 是每邻居的计数器（node.rs:3120-3128）。
type degradeCounter struct {
	bad      uint32
	good     uint32
	cooldown uint32
	udpOK    *bool
}

// DegradeThresholds 是可调阈值（默认对齐 node.rs + policy.rs）。
type DegradeThresholds struct {
	ConsecutiveBad  uint32  // 3
	ConsecutiveGood uint32  // 3
	LossBad         float64 // 0.20
	LossGood        float64 // 0.05
	RTTBadMS        uint32  // 300
	RTTGoodMS       uint32  // 150
	CooldownTicks   uint32  // 10
	ProbeTimeoutMS  uint32  // 2000
}

func DefaultDegradeThresholds() DegradeThresholds {
	return DegradeThresholds{
		ConsecutiveBad: NBadWindows, ConsecutiveGood: NGoodWindows,
		LossBad: BadLossPct / 100.0, LossGood: GoodLossPct / 100.0,
		RTTBadMS: BadRttMS, RTTGoodMS: GoodRttMS,
		CooldownTicks: CooldownTicks, ProbeTimeoutMS: ProbeTimeoutMS,
	}
}

// DegradePolicy 管理所有邻居的降级判定（node.rs:3130-3255）。
type DegradePolicy struct {
	mu         sync.Mutex
	counters   map[NodeID]*degradeCounter
	thresholds DegradeThresholds
}

func NewDegradePolicy() *DegradePolicy {
	return &DegradePolicy{
		counters:   make(map[NodeID]*degradeCounter),
		thresholds: DefaultDegradeThresholds(),
	}
}

// Observe 单次观测（每 tick 每邻居一次），纯函数式无时间依赖（node.rs:3183-3255）。
func (p *DegradePolicy) Observe(peer NodeID, kind TransportKind, loss float64, samples uint32, rttMS uint32) Decision {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.counters[peer]
	if c == nil {
		c = &degradeCounter{}
		p.counters[peer] = c
	}
	if c.cooldown > 0 {
		c.cooldown--
		return Decision{Kind: DecisionStay}
	}
	t := p.thresholds
	enough := samples >= lossMinSamples
	badLoss := enough && loss > t.LossBad
	badRTT := enough && rttMS > t.RTTBadMS
	// 加 1e-9 容差：20 窗里 1 个丢包 = 1-18/20 = 0.050000000000000044，
	// 严格 <=0.05 因浮点误差为 false，回切永远卡住（真机 debug 暴露）。
	goodLoss := enough && loss <= t.LossGood+1e-9
	goodRTT := enough && rttMS <= t.RTTGoodMS

	switch kind {
	case TransportUDP:
		c.good = 0
		if enough {
			ok := !(badLoss || badRTT)
			c.udpOK = &ok
		}
		if badLoss || badRTT {
			c.bad++
		} else {
			c.bad = 0
		}
		if c.bad >= t.ConsecutiveBad {
			c.bad = 0
			c.cooldown = t.CooldownTicks
			reason := fmt.Sprintf("UDP 连续 %d 窗丢包 > %d%%", t.ConsecutiveBad, int(t.LossBad*100))
			if !badLoss {
				reason = fmt.Sprintf("UDP 连续 %d 窗 RTT > %dms", t.ConsecutiveBad, t.RTTBadMS)
			}
			return Decision{Kind: DecisionToWSS, Reason: reason}
		}
	case TransportWSS:
		c.bad = 0
		if goodLoss && goodRTT {
			c.good++
		} else {
			c.good = 0
		}
		if c.good >= t.ConsecutiveGood {
			c.good = 0
			c.cooldown = t.CooldownTicks
			return Decision{Kind: DecisionToUDP, Reason: fmt.Sprintf(
				"UDP 探针连续 %d 窗良好（丢包 <%d%% 且 RTT ≤%dms）",
				t.ConsecutiveGood, int(t.LossGood*100), t.RTTGoodMS)}
		}
	}
	return Decision{Kind: DecisionStay}
}

// UdpHealthy 返回 UDP 档位下最近一次样本是否健康（无样本保守 false，node.rs:3161-3166）。
func (p *DegradePolicy) UdpHealthy(peer NodeID) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.counters[peer]; c != nil && c.udpOK != nil {
		return *c.udpOK
	}
	return false
}

// Counters 返回 (bad, good, cooldown)（诊断用，node.rs:3168-3174）。
func (p *DegradePolicy) Counters(peer NodeID) (bad, good, cooldown uint32) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.counters[peer]; c != nil {
		return c.bad, c.good, c.cooldown
	}
	return 0, 0, 0
}

// BeginCooldown 切换/采纳链路后进入冷却（node.rs:3176-3180）。
func (p *DegradePolicy) BeginCooldown(peer NodeID) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.counters[peer]
	if c == nil {
		c = &degradeCounter{}
		p.counters[peer] = c
	}
	c.cooldown = p.thresholds.CooldownTicks
}
