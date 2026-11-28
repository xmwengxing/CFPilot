package mesh

import (
	"net"
	"sync/atomic"
)

// W3：hub 入站分账（七类 + 队列丢弃），对齐 MobiHop K24 §6.1 / hub.rs 的 RX_TOTAL 口径。
//
// 分账不变式（必须恒成立）：
//
//	RXTotal == Direct + Relay + Discovered + Probe + Control + Raw + Malformed
//
// 残差（HubRxStats.Unexplained）必须恒为 0。非 0 就说明 demux 里有一条 return
// 路径没记账 —— MobiHop 真机上正是这样漏出「残差恒为 5」：UdpProbe 与解不出
// 帧头的裸负载各自提前 return，谁都只加了 rx_total。
//
// 与 Status.RXDirect / RXRelayed 的区别（不要互相替代）：
//   - 那两个是**链路分类**：某一帧是从直连链路还是中继腿收到的（K24 §6.1）；
//   - 这里分的是**入口类型**：这个 UDP 数据报进来时走了 demux 的哪条分支。
// 一帧可以入口算 relay（中继地址送来），转发出去后又按链路记一次 TX。
//
// 为什么必须分成这些桶：真机排查「txFrames 涨、rxFrames 不涨」时，只有知道
// 帧是「没来」「来了没解出来」还是「来了但被队列丢」才能定位；只加一个总数
// 只会得到「有帧被无计数地吞掉」这种无法行动的结论。

type rxClass uint8

const (
	rxClassDirect rxClass = iota + 1
	rxClassRelay
	rxClassDiscovered
	rxClassProbe
	rxClassControl
	rxClassRaw
	rxClassMalformed
)

// String 返回分类的短名（日志与单测断言用）。
func (c rxClass) String() string {
	switch c {
	case rxClassDirect:
		return "direct"
	case rxClassRelay:
		return "relay"
	case rxClassDiscovered:
		return "discovered"
	case rxClassProbe:
		return "probe"
	case rxClassControl:
		return "control"
	case rxClassRaw:
		return "raw"
	case rxClassMalformed:
		return "malformed"
	default:
		return "unknown"
	}
}

// hubRxCounters 是 UdpHub 的原子计数器（demux 单 goroutine 写，面板并发读）。
type hubRxCounters struct {
	total      atomic.Uint64
	direct     atomic.Uint64
	relay      atomic.Uint64
	discovered atomic.Uint64
	probe      atomic.Uint64
	control    atomic.Uint64
	raw        atomic.Uint64
	malformed  atomic.Uint64
	// queueDrop 是「分类已入账、但投进 peer 队列时队列满」的帧数。
	// 它是分类的子集（不另立门户），所以不计入 Unexplained。
	queueDrop atomic.Uint64
}

func (c *hubRxCounters) add(class rxClass) {
	switch class {
	case rxClassDirect:
		c.direct.Add(1)
	case rxClassRelay:
		c.relay.Add(1)
	case rxClassDiscovered:
		c.discovered.Add(1)
	case rxClassProbe:
		c.probe.Add(1)
	case rxClassControl:
		c.control.Add(1)
	case rxClassRaw:
		c.raw.Add(1)
	case rxClassMalformed:
		c.malformed.Add(1)
	}
}

// HubRxStats 是 hub 入站分账快照（Status.HubRX，JSON 契约）。
type HubRxStats struct {
	// Total 是 demux 读到的数据报总数（分账分母）。
	Total uint64 `json:"total"`
	// Direct 是已登记直连地址通道上的帧。
	Direct uint64 `json:"direct"`
	// Relay 是从已登记中继地址到达、按帧头 src 归到对端腿的帧。
	Relay uint64 `json:"relay"`
	// Discovered 是首次出现的新地址（建链后入账）。
	Discovered uint64 `json:"discovered"`
	// Probe 是入站 UdpProbe（不进普通队列，直接交探针跟踪器）。
	Probe uint64 `json:"probe"`
	// Control 是打洞 / 中继管理帧（HolePunch 只观察；RelayMgmt 观察后仍投递）。
	Control uint64 `json:"control"`
	// Raw 不是本协议报文（首字节非 magic：STUN 响应、打洞裸负载）。
	Raw uint64 `json:"raw"`
	// Malformed 是 magic 对但解不出 32B 帧头（截断 / 篡改）。
	Malformed uint64 `json:"malformed"`
	// QueueDrop 是 peer 队列满被丢弃的帧（Direct/Relay/Discovered 的子集）。
	QueueDrop uint64 `json:"queueDrop"`
}

// Classified 返回七类之和。
func (s HubRxStats) Classified() uint64 {
	return s.Direct + s.Relay + s.Discovered + s.Probe + s.Control + s.Raw + s.Malformed
}

// Unexplained 返回分账残差（应恒为 0；非 0 即有帧被无计数地吞掉）。
func (s HubRxStats) Unexplained() int64 {
	return int64(s.Total) - int64(s.Classified())
}

// RXStats 返回 hub 入站分账快照。
func (h *UdpHub) RXStats() HubRxStats {
	if h == nil {
		return HubRxStats{}
	}
	return HubRxStats{
		Total:      h.rx.total.Load(),
		Direct:     h.rx.direct.Load(),
		Relay:      h.rx.relay.Load(),
		Discovered: h.rx.discovered.Load(),
		Probe:      h.rx.probe.Load(),
		Control:    h.rx.control.Load(),
		Raw:        h.rx.raw.Load(),
		Malformed:  h.rx.malformed.Load(),
		QueueDrop:  h.rx.queueDrop.Load(),
	}
}

// observeDatagram 是**唯一**的入账入口：先记分母，再按 dispatch 返回的分类记分子。
// 单测直接调它就能验证「一次数据报只贡献一次 rx_total、且恰好落进一个桶」。
func (h *UdpHub) observeDatagram(remote *net.UDPAddr, frame []byte) {
	h.rx.total.Add(1)
	h.rx.add(h.dispatch(remote, frame))
}
