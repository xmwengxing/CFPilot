package mesh

import "sync/atomic"

// W3：丢弃原因分类。
//
// 为什么不能只有一个 forwardDropped / txDropped：真机上「发了但没通」有六种完全
// 不同的原因，处置方式也不同 ——
//   - noRoute：转发表里没有可用下一跳（拓扑没收敛 / 对端下线）→ 等 Gossip 或查链路；
//   - ttl：多跳 TTL 耗尽（环路或路径过长）→ 查拓扑，不是丢包；
//   - encode：帧重组失败（实现 bug 或内存损坏）→ 必查；
//   - sendFail：候选下一跳全部发送失败（网卡 / socket 错）→ 查本机网络；
//   - unknownVip：出站包目的不在虚拟 IP 表（对端没登记 / 子网网关未实现）→ 查配置；
//   - badPacket：TUN 读出的根本不是可解析 IP 包（系统噪声）。
// 混成一个数就只能得到「有丢包」这种无法行动的结论。
//
// 队列满（hub 收队列）不在这里：它属于入口分账的子集，见 HubRxStats.QueueDrop。

// dropCounters 是生命周期内的原子计数器。
type dropCounters struct {
	noRoute    atomic.Uint64
	ttl        atomic.Uint64
	encode     atomic.Uint64
	sendFail   atomic.Uint64
	unknownVIP atomic.Uint64
	badPacket  atomic.Uint64
}

// DropStats 是丢弃原因快照（Status.Drops，JSON 契约）。
type DropStats struct {
	// NoRoute 是没有可用下一跳（含无静态公钥、握手无法发起）而丢弃的帧数。
	NoRoute uint64 `json:"noRoute"`
	// TTL 是多跳转发时 TTL 耗尽丢弃的帧数。
	TTL uint64 `json:"ttl"`
	// Encode 是重组帧失败（只可能是实现 bug）而丢弃的帧数。
	Encode uint64 `json:"encode"`
	// SendFail 是所有候选下一跳都发送失败而丢弃的帧数。
	SendFail uint64 `json:"sendFail"`
	// UnknownVIP 是出站包目的不在虚拟 IP 表（含未实现的子网网关）而丢弃的帧数。
	UnknownVIP uint64 `json:"unknownVip"`
	// BadPacket 是 TUN 读出但解析不出目的地址的包数（系统噪声）。
	BadPacket uint64 `json:"badPacket"`
}

// snapshot 返回当前快照。
func (c *dropCounters) snapshot() DropStats {
	if c == nil {
		return DropStats{}
	}
	return DropStats{
		NoRoute:    c.noRoute.Load(),
		TTL:        c.ttl.Load(),
		Encode:     c.encode.Load(),
		SendFail:   c.sendFail.Load(),
		UnknownVIP: c.unknownVIP.Load(),
		BadPacket:  c.badPacket.Load(),
	}
}
