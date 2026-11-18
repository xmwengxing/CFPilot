package mesh

import "sync"

// PeerWireVersions 记录「每个对端用哪个线速版本」，是 ADR-0016 降级协商的 Go 侧实现。
//
// ## 学习纪律（对齐 MobiHop router.rs / session.rs）
//
// 只从**解码成功**的入站帧学习：v1 帧在 Decode 里已过 `buf[5] == 0` 校验，
// 所以一条伪造的 v1 帧最多让本机把该对端降级到单槽（仍是 AEAD 认证会话），
// 不损机密性，只损槽位效率。
//
// 未知对端一律先按 **v2** 发送（它同时接受 v1/v2），由对端回帧教会我们它的版本；
// 一直学不到时由握手重试兜底降级到 v1（见 HandshakeFSM.RetryPending）。
//
// ## 为什么必须按对端而不是全局固定
//
// v1 节点在头部版本校验处直接丢 0x02 帧。若全局固定只发 v2，混合集群里旧节点
// 永远收不到任何控制帧（Gossip / Ping / RelayMgmt），拓扑也就永远收敛不了。
type PeerWireVersions struct {
	mu sync.RWMutex
	m  map[NodeID]byte
}

func NewPeerWireVersions() *PeerWireVersions {
	return &PeerWireVersions{m: make(map[NodeID]byte)}
}

// Learn 记录对端版本；只接受 v1/v2（其它值来自不可靠输入，忽略）。
func (p *PeerWireVersions) Learn(src NodeID, version byte) {
	if version != WireVersionV1 && version != WireVersionV2 {
		return
	}
	p.mu.Lock()
	p.m[src] = version
	p.mu.Unlock()
}

// VersionFor 返回发给该对端应使用的版本；未知时用当前默认（v2）。
func (p *PeerWireVersions) VersionFor(id NodeID) byte {
	p.mu.RLock()
	v, ok := p.m[id]
	p.mu.RUnlock()
	if ok {
		return v
	}
	return WireVersionDefault
}

// Known 报告是否已学到该对端版本（握手重试据此判断要不要降级）。
func (p *PeerWireVersions) Known(id NodeID) bool {
	p.mu.RLock()
	_, ok := p.m[id]
	p.mu.RUnlock()
	return ok
}

// ForceVersion 强制设置某对端版本（握手 5s 无回帧时降级用）。
func (p *PeerWireVersions) ForceVersion(id NodeID, version byte) {
	p.Learn(id, version)
}
