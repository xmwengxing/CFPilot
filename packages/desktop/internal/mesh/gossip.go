package mesh

import (
	"sort"
	"sync"
	"time"
)

// Gossip 维护节点描述符库（LSDB）并生成/校验 Gossip 消息。
// 对齐 MobiHop gossip.rs:31-48 + K22 反熵：收到的描述符由各节点重算转发表。
//
// W2 起 CFPilot 做**全量反熵**（对齐 MobiHop 的 LSDB 同步）：每条 Gossip 消息
// 既带本地描述符，也带本机已知的其它描述符，按字节预算截断。只广播自己的描述符
// 时，A—B—C 三个节点永远只有「直连邻居」的一手信息，多跳拓扑不收敛。
//
// 邻居声明（Neighbors）是本机对**直连对端**的实测质量（rtt/loss），
// 由生命周期在每次广播前刷新（SetNeighbors），是 Dijkstra 的边权来源。
type Gossip struct {
	mu        sync.RWMutex
	selfID    NodeID
	localDesc NodeDescriptor
	lsdb      map[NodeID]NodeDescriptor
	seen      map[NodeID]time.Time
	version   uint64
	seq       uint64
	neighbors []NeighborEntry
	identSeed [32]byte
	identPub  [32]byte
	tunnelPub [32]byte
	virtualIP string
}

const (
	// DescriptorLease 是 LSDB 条目的保鲜期（gossip.rs 的 lease 语义近似）。
	// 超过该时长没再收到刷新就丢弃：否则已下线节点会长期留在转发表里当黑洞。
	DescriptorLease = 15 * time.Minute
	// gossipMaxDescriptors 是单条 Gossip 消息携带的描述符数量上限（防御性）。
	gossipMaxDescriptors = 64
)

// NewGossip 用本机身份与虚拟 IP 构造 Gossip 引擎（本地描述符自动签名）。
func NewGossip(ident *Identity, virtualIP string) (*Gossip, error) {
	var pub, tun [32]byte
	copy(pub[:], ident.IdentityPub)
	copy(tun[:], ident.TunnelPub)
	g := &Gossip{
		selfID:    ident.NodeID,
		lsdb:      make(map[NodeID]NodeDescriptor),
		seen:      make(map[NodeID]time.Time),
		seq:       1,
		identSeed: ident.IdentitySeed,
		identPub:  pub,
		tunnelPub: tun,
		virtualIP: virtualIP,
	}
	if err := g.rebuildLocal(); err != nil {
		return nil, err
	}
	g.lsdb[ident.NodeID] = g.localDesc
	g.seen[ident.NodeID] = time.Now()
	return g, nil
}

// rebuildLocal 重建并签名本地描述符（虚拟 IP / 邻居 / seq 变化时调用）。
func (g *Gossip) rebuildLocal() error {
	d := NodeDescriptor{
		NodeID:      g.selfID,
		IdentityPub: g.identPub,
		TunnelPub:   g.tunnelPub,
		VirtualIPv4: g.virtualIP,
		Neighbors:   append([]NeighborEntry{}, g.neighbors...),
		Seq:         g.seq,
	}
	if err := d.Sign(g.identSeed); err != nil {
		return err
	}
	g.localDesc = d
	g.lsdb[g.selfID] = d
	return nil
}

// LocalDescriptorBytes 返回已签名的本地描述符（用于广播）。
func (g *Gossip) LocalDescriptorBytes() ([]byte, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.localDesc.Encode()
}

// GossipMessageBytes 返回包含本地描述符的 Gossip 帧载荷（向后兼容入口）。
func (g *Gossip) GossipMessageBytes() ([]byte, error) {
	return g.SnapshotBytes(0)
}

// SnapshotBytes 返回「本地 + 已知」描述符的反熵载荷，总长不超过 budget 字节。
// budget<=0 时用 MaxPayload。超预算时按「本地优先、其余按 NodeID 升序」截断：
// 本机描述符永远在，链路再窄也不会因为装不下别人而让自己消失。
func (g *Gossip) SnapshotBytes(budget int) ([]byte, error) {
	if budget <= 0 || budget > MaxPayload {
		budget = MaxPayload
	}
	g.mu.Lock()
	g.pruneLocked(time.Now())
	local := g.localDesc
	known := make([]NodeDescriptor, 0, len(g.lsdb))
	for id, d := range g.lsdb {
		if id == g.selfID {
			continue
		}
		known = append(known, d)
	}
	g.mu.Unlock()

	sort.Slice(known, func(i, j int) bool { return lessNodeID(known[i].NodeID, known[j].NodeID) })
	cands := append([]NodeDescriptor{local}, known...)
	if len(cands) > gossipMaxDescriptors {
		cands = cands[:gossipMaxDescriptors]
	}
	for n := len(cands); n >= 2; n-- {
		raw, err := (&GossipMessage{Descriptors: cands[:n]}).Encode()
		if err != nil {
			return nil, err
		}
		if len(raw) <= budget {
			return raw, nil
		}
	}
	// 连一个描述符都装不下时至少把本地描述符发出去（否则拓扑永不收敛）。
	return (&GossipMessage{Descriptors: cands[:1]}).Encode()
}

// pruneLocked 丢弃超过 DescriptorLease 未刷新的条目（本机条目除外）。
func (g *Gossip) pruneLocked(now time.Time) {
	changed := false
	for id, at := range g.seen {
		if id == g.selfID {
			continue
		}
		if now.Sub(at) > DescriptorLease {
			delete(g.seen, id)
			delete(g.lsdb, id)
			changed = true
		}
	}
	if changed {
		g.version++
	}
}

// OnGossip 处理收到的 Gossip 帧：验签每个描述符，valid 则入 LSDB。
// 返回新登记/更新的描述符（调用方据此更新虚拟 IP 表与转发表）。
func (g *Gossip) OnGossip(frameBytes []byte) ([]NodeDescriptor, error) {
	msg, err := DecodeGossip(frameBytes)
	if err != nil {
		return nil, err
	}
	var added []NodeDescriptor
	now := time.Now()
	for _, d := range msg.Descriptors {
		if d.NodeID == g.selfID {
			continue // 自己的描述符忽略
		}
		if err := d.Verify(); err != nil {
			continue // 伪造/篡改描述符丢弃
		}
		g.mu.Lock()
		g.pruneLocked(now)
		old, exists := g.lsdb[d.NodeID]
		// Lamport 序号：只接受更新的描述符
		if !exists || d.Seq > old.Seq {
			g.lsdb[d.NodeID] = d
			g.seen[d.NodeID] = now
			g.version++
			added = append(added, d)
		} else {
			g.seen[d.NodeID] = now // 旧序号但确实刷新过：续租
		}
		g.mu.Unlock()
	}
	return added, nil
}

// SetNeighbors 更新本地邻居声明；内容不变时不重签、不动 seq（避免签名抖动）。
// 返回是否真的发生了变化。邻居变化必须体现在描述符里，否则对端算不出多跳路径。
func (g *Gossip) SetNeighbors(entries []NeighborEntry) (bool, error) {
	norm := normalizeNeighbors(entries, g.selfID)
	g.mu.Lock()
	defer g.mu.Unlock()
	if sameNeighbors(g.neighbors, norm) {
		return false, nil
	}
	g.neighbors = norm
	g.seq++
	if err := g.rebuildLocal(); err != nil {
		return false, err
	}
	g.version++
	return true, nil
}

// Neighbors 返回当前本地邻居声明（诊断用）。
func (g *Gossip) Neighbors() []NeighborEntry {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return append([]NeighborEntry{}, g.neighbors...)
}

// Version 返回 LSDB / 本地描述符的版本号：变化即需要重算转发表。
func (g *Gossip) Version() uint64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.version
}

// Descriptors 返回 LSDB 全量快照（含本机），供路由计算。
func (g *Gossip) Descriptors() map[NodeID]NodeDescriptor {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make(map[NodeID]NodeDescriptor, len(g.lsdb))
	for id, d := range g.lsdb {
		out[id] = d
	}
	return out
}

// LookupVirtualIP 查某节点的虚拟 IP（从 LSDB）。
func (g *Gossip) LookupVirtualIP(id NodeID) (string, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	d, ok := g.lsdb[id]
	if !ok || d.VirtualIPv4 == "" {
		return "", false
	}
	return d.VirtualIPv4, true
}

// AllPeers 返回 LSDB 中所有非本机描述符（用于虚拟 IP 表全量重建）。
func (g *Gossip) AllPeers() []NodeDescriptor {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]NodeDescriptor, 0, len(g.lsdb))
	for id, d := range g.lsdb {
		if id == g.selfID {
			continue
		}
		out = append(out, d)
	}
	return out
}

// BumpSeq 递增本地 seq 并重新签名（虚拟 IP 等本机属性变化时调用）。
func (g *Gossip) BumpSeq() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.seq++
	if err := g.rebuildLocal(); err != nil {
		return err
	}
	g.version++
	return nil
}

// DescriptorCount 返回 LSDB 大小（诊断）。
func (g *Gossip) DescriptorCount() int {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return len(g.lsdb)
}

// normalizeNeighbors 去掉自环与重复项，按 NodeID 升序排列，并量化丢包率。
// 排序是为了让「同一组邻居」的编码稳定：描述符内容一抖就得重签 + 全量重传。
func normalizeNeighbors(in []NeighborEntry, self NodeID) []NeighborEntry {
	seen := make(map[NodeID]struct{}, len(in))
	out := make([]NeighborEntry, 0, len(in))
	for _, e := range in {
		if e.NodeID == self {
			continue
		}
		if _, dup := seen[e.NodeID]; dup {
			continue
		}
		seen[e.NodeID] = struct{}{}
		e.LossRate = QuantizeLoss(e.LossRate)
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return lessNodeID(out[i].NodeID, out[j].NodeID) })
	return out
}

func sameNeighbors(a, b []NeighborEntry) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].NodeID != b[i].NodeID || a[i].RTTMS != b[i].RTTMS ||
			a[i].LossRate != b[i].LossRate || !sameU32Ptr(a[i].RTTMinMS, b[i].RTTMinMS) ||
			!sameU32Ptr(a[i].JitterMS, b[i].JitterMS) {
			return false
		}
	}
	return true
}

func sameU32Ptr(a, b *uint32) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
