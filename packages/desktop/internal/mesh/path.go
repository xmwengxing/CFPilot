package mesh

import (
	"fmt"
	"sort"
	"time"
)

// Path Manager 选路（契约 §5，对齐 MobiHop crates/mobihop-node/src/path.rs）。
//
// 评分公式（H3-2 质量加权，见 PathCandidate.Score）：
// score = 1.0*rtt_min + 1.5*(rtt-rtt_min) + 2.0*jitter + loss*500 + 15/跳
// 切换纪律：先探测后切换 + 滞回 10ms + 冷却 1s + 失效回滚上一路径。
//
// ## ⚠️ 路由覆盖（H0-2b）的纪律
//
// MobiHop 的 `PathManager.active_paths_map()` 只供**展示**，禁止喂给
// `Router::set_path_overrides`；路由覆盖只应包含「**经中继**的激活路径」。
// 早期把直连也写成 `dst → dst` 的恒等覆盖，会把 Dijkstra 的选路强行按回直连，
// 于是真实丢包写进 LSDB 也绕不开（H0-2 的收益归零）。
//
// CFPilot Go 子集目前没有 Router 覆盖接口（只有 PathManager 自身决策），
// 因此不存在这个 bug；**将来若加覆盖入口，必须只下发经中继的档位**。

// PathID 是一条路径的标识：直连对端 或 经中继（契约 §5.1，path.rs:36-60）。
type PathID struct {
	Direct bool   // true = 直连对端；false = 经中继
	Peer   NodeID // 直连时的对端 / 中继时的中继节点
}

func (p PathID) RelayPenaltyMS() float64 {
	if p.Direct {
		return 0
	}
	return RelayPenaltyMS
}

func (p PathID) String() string {
	if p.Direct {
		return fmt.Sprintf("direct:%x", p.Peer[:4])
	}
	return fmt.Sprintf("relay:%x", p.Peer[:4])
}

// PathCandidate 是候选路径的测量与状态（path.rs:63-95 + H3-2 质量样本）。
type PathCandidate struct {
	Path        PathID
	RTTMS       uint32
	LossRate    float64
	Validated   bool // 先探测后切换的凭据
	Failed      bool // 链路丢失 / 中继宕机
	LastProbeMS uint64

	// H3-2：质量样本（nil = 无样本，退化为旧公式）。
	//   RTTMinMS：窗口内最小观测值（只降不升）
	//   JitterMS：RFC 3550 §6.4.1 的抖动估计
	RTTMinMS *uint32
	JitterMS *uint32
}

// Score 返回边权（对齐 route.rs:43 edge_cost_quality）。
//
//	edge_cost = W_RTT_MIN*rtt_min + W_RTT_VAR*max(0, rtt - rtt_min)
//	          + W_JITTER*jitter + loss*500 + relay_penalty(每跳 15ms)
//
// 缺样本时 rtt_min = rtt、variance = 0、jitter = 0 ⇒ 退化为
// `rtt + loss*500 + 15`，与 H3 之前完全等价（避免改公式反而让旧边变贵）。
// `rtt_min` 再做一次 min(rtt) 夹紧：样本回退时声明值可能大于当前 RTT，
// 不夹会让 variance 变负、把丢包边算得比直连还便宜。
func (c *PathCandidate) Score() float64 {
	rtt := float64(c.RTTMS)
	rttMin := rtt
	if c.RTTMinMS != nil {
		rttMin = float64(*c.RTTMinMS)
		if rttMin > rtt {
			rttMin = rtt
		}
	}
	variance := rtt - rttMin
	if variance < 0 {
		variance = 0
	}
	jitter := 0.0
	if c.JitterMS != nil {
		jitter = float64(*c.JitterMS)
	}
	return WRttMin*rttMin + WRttVar*variance + WJitter*jitter +
		c.LossRate*LossWeight + c.Path.RelayPenaltyMS()
}

func (c *PathCandidate) usable() bool { return c.Validated && !c.Failed }

// SwitchRecord 是切换日志（path.rs:102-109）。
type SwitchRecord struct {
	AtMS   uint64
	Dst    NodeID
	From   *PathID
	To     PathID
	Reason string
}

// PathConfig 是选路参数（path.rs:112-130）。
type PathConfig struct {
	HysteresisMS     float64
	SwitchCooldownMS uint64
	ProbeTimeoutMS   uint64
}

func DefaultPathConfig() PathConfig {
	return PathConfig{
		HysteresisMS:     HysteresisMS,
		SwitchCooldownMS: SwitchCooldownMS,
		ProbeTimeoutMS:   ProbeTimeoutMS,
	}
}

// PathManager 管理到各对端的候选路径与当前激活路径。
type PathManager struct {
	Cfg          PathConfig
	NowMS        uint64
	Candidates   map[NodeID][]PathCandidate // dst -> 候选路径列表
	Active       map[NodeID]PathID          // dst -> 当前激活路径
	Previous     map[NodeID]PathID          // dst -> 上一路径（回滚用）
	LastSwitchMS map[NodeID]uint64          // dst -> 上次切换时刻
	SwitchLog    []SwitchRecord
}

func NewPathManager(cfg PathConfig) *PathManager {
	return &PathManager{
		Cfg:          cfg,
		Candidates:   make(map[NodeID][]PathCandidate),
		Active:       make(map[NodeID]PathID),
		Previous:     make(map[NodeID]PathID),
		LastSwitchMS: make(map[NodeID]uint64),
	}
}

func nowMS() uint64 { return uint64(time.Now().UnixMilli()) }

// SetCandidates 设置到某对端的候选路径（带当前时间戳作为 last_probe）。
func (m *PathManager) SetCandidates(dst NodeID, paths []PathID) {
	cands := make([]PathCandidate, 0, len(paths))
	for _, p := range paths {
		cands = append(cands, PathCandidate{Path: p, LastProbeMS: m.NowMS})
	}
	m.Candidates[dst] = cands
}

// ApplyMeasurement 更新某条路径的实测 RTT/丢包并标记 validated（契约 §5.4）。
func (m *PathManager) ApplyMeasurement(dst, via NodeID, rttMS uint32, lossRate float64) bool {
	cands := m.Candidates[dst]
	for i := range cands {
		if cands[i].Path.Peer == via {
			cands[i].RTTMS = rttMS
			cands[i].LossRate = lossRate
			cands[i].Validated = true
			cands[i].Failed = false
			cands[i].LastProbeMS = m.NowMS
			m.Candidates[dst] = cands
			return true
		}
	}
	return false
}

// ApplyQuality 更新某条路径的质量样本（H3-2）：
// rtt_min 取窗口最小、jitter 取 RFC 3550 平滑值（由调用方维护窗口/EWMA）。
func (m *PathManager) ApplyQuality(dst, via NodeID, rttMinMS, jitterMS uint32) bool {
	cands := m.Candidates[dst]
	for i := range cands {
		if cands[i].Path.Peer == via {
			minV := rttMinMS
			jitV := jitterMS
			cands[i].RTTMinMS = &minV
			cands[i].JitterMS = &jitV
			m.Candidates[dst] = cands
			return true
		}
	}
	return false
}

// bestUsable 返回可用候选中评分最低的一条（契约 §5.3）。
func (m *PathManager) bestUsable(dst NodeID) (PathCandidate, bool) {
	var best PathCandidate
	found := false
	for _, c := range m.Candidates[dst] {
		if !c.usable() {
			continue
		}
		if !found || c.Score() < best.Score() {
			best = c
			found = true
		}
	}
	return best, found
}

func (m *PathManager) activeScore(dst NodeID) (float64, bool) {
	cur, ok := m.Active[dst]
	if !ok {
		return 0, false
	}
	for _, c := range m.Candidates[dst] {
		if c.Path == cur && c.usable() {
			return c.Score(), true
		}
	}
	return 0, false
}

func (m *PathManager) recordSwitch(dst NodeID, to PathID, reason string) SwitchRecord {
	var fromPtr *PathID
	if from, exists := m.Active[dst]; exists {
		fromCopy := from
		fromPtr = &fromCopy
		if from != to {
			m.Previous[dst] = from
		}
	}
	m.Active[dst] = to
	m.LastSwitchMS[dst] = m.NowMS
	r := SwitchRecord{AtMS: m.NowMS, Dst: dst, From: fromPtr, To: to, Reason: reason}
	m.SwitchLog = append(m.SwitchLog, r)
	return r
}

// Reevaluate 重新评估选路，返回切换记录（无切换返回 nil）。
// 严格对齐 path.rs:435-476：
//  1. 无可用候选 → nil
//  2. 无当前激活 → 初始选路
//  3. 当前路径失效 → 优先回滚上一路径，其次选最优
//  4. 滞回：新路径必须优出 hysteresis_ms
//  5. 冷却：切换后 cooldown 内不再切
func (m *PathManager) Reevaluate(dst NodeID) *SwitchRecord {
	best, ok := m.bestUsable(dst)
	if !ok {
		return nil
	}
	cur, hasCur := m.Active[dst]
	if !hasCur {
		r := m.recordSwitch(dst, best.Path, "初始选路")
		return &r
	}

	// 当前激活路径是否失效
	curFailed := true
	for _, c := range m.Candidates[dst] {
		if c.Path == cur {
			curFailed = !c.usable()
			break
		}
	}
	if curFailed {
		rollback, hasRollback := m.Previous[dst]
		if hasRollback {
			// 确认回滚目标仍可用
			usable := false
			for _, c := range m.Candidates[dst] {
				if c.Path == rollback && c.usable() {
					usable = true
					break
				}
			}
			if !usable {
				hasRollback = false
			}
		}
		target := best.Path
		reason := "当前路径失效：切换到最优路径"
		if hasRollback {
			target = rollback
			reason = "当前路径失效：回滚到上一路径"
		}
		r := m.recordSwitch(dst, target, reason)
		return &r
	}

	// 滞回
	curScore, ok := m.activeScore(dst)
	if !ok {
		return nil
	}
	if best.Path == cur || best.Score()+m.Cfg.HysteresisMS >= curScore {
		return nil
	}
	// 冷却
	last := m.LastSwitchMS[dst]
	if m.NowMS >= last && m.NowMS-last < m.Cfg.SwitchCooldownMS {
		return nil
	}
	r := m.recordSwitch(dst, best.Path, "探测到更优路径")
	return &r
}

// OnLinkLoss 标记链路失效并立即重新评估（path.rs:478+）。
func (m *PathManager) OnLinkLoss(dst, via NodeID) *SwitchRecord {
	cands := m.Candidates[dst]
	for i := range cands {
		if cands[i].Path.Peer == via {
			cands[i].Failed = true
			cands[i].Validated = false
		}
	}
	m.Candidates[dst] = cands
	return m.Reevaluate(dst)
}

// ActivePath 返回当前激活路径。
func (m *PathManager) ActivePath(dst NodeID) (PathID, bool) {
	p, ok := m.Active[dst]
	return p, ok
}

// SortByScore 按评分排序候选（仅供诊断/测试）。
func SortByScore(cands []PathCandidate) []PathCandidate {
	out := append([]PathCandidate(nil), cands...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score() < out[j].Score() })
	return out
}
