package mesh

import "sync"

// Gossip 维护节点描述符库（LSDB）并生成/校验 Gossip 消息。
// 对齐 MobiHop gossip.rs:31-48 —— 收到描述符后由各节点重算虚拟 IP 转发表。
//
// CFPilot 的精简实现：只维护描述符与虚拟 IP 映射，不做完整 Dijkstra
// （选路仍由 PathManager + DegradeController 负责）。关键是让 A 能自动
// 得知 B 的虚拟 IP，实现"一次链接、双向自动发现"。
type Gossip struct {
	mu        sync.RWMutex
	selfID    NodeID
	localDesc NodeDescriptor
	lsdb      map[NodeID]NodeDescriptor
	seq       uint64
	identSeed [32]byte
	identPub  [32]byte
	tunnelPub [32]byte
	virtualIP string
}

// NewGossip 用本机身份与虚拟 IP 构造 Gossip 引擎（本地描述符自动签名）。
func NewGossip(ident *Identity, virtualIP string) (*Gossip, error) {
	var pub, tun [32]byte
	copy(pub[:], ident.IdentityPub)
	copy(tun[:], ident.TunnelPub)
	g := &Gossip{
		selfID:    ident.NodeID,
		lsdb:      make(map[NodeID]NodeDescriptor),
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
	return g, nil
}

// rebuildLocal 重建并签名本地描述符（虚拟 IP / seq 变化时调用）。
func (g *Gossip) rebuildLocal() error {
	d := NodeDescriptor{
		NodeID:      g.selfID,
		IdentityPub: g.identPub,
		TunnelPub:   g.tunnelPub,
		VirtualIPv4: g.virtualIP,
		Neighbors:   []NeighborEntry{},
		Seq:         g.seq,
	}
	if err := d.Sign(g.identSeed); err != nil {
		return err
	}
	g.localDesc = d
	return nil
}

// LocalDescriptorBytes 返回已签名的本地描述符（用于广播）。
func (g *Gossip) LocalDescriptorBytes() ([]byte, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.localDesc.Encode()
}

// GossipMessageBytes 返回包含本地描述符的 Gossip 帧载荷。
func (g *Gossip) GossipMessageBytes() ([]byte, error) {
	g.mu.RLock()
	msg := GossipMessage{Descriptors: []NodeDescriptor{g.localDesc}}
	g.mu.RUnlock()
	return msg.Encode()
}

// OnGossip 处理收到的 Gossip 帧：验签每个描述符，valid 则入 LSDB。
// 返回新登记的描述符（调用方据此更新虚拟 IP 表）。
func (g *Gossip) OnGossip(frameBytes []byte) ([]NodeDescriptor, error) {
	msg, err := DecodeGossip(frameBytes)
	if err != nil {
		return nil, err
	}
	var added []NodeDescriptor
	for _, d := range msg.Descriptors {
		if d.NodeID == g.selfID {
			continue // 自己的描述符忽略
		}
		if err := d.Verify(); err != nil {
			continue // 伪造/篡改描述符丢弃
		}
		g.mu.Lock()
		old, exists := g.lsdb[d.NodeID]
		// Lamport 序号：只接受更新的描述符
		if !exists || d.Seq > old.Seq {
			g.lsdb[d.NodeID] = d
			added = append(added, d)
		}
		g.mu.Unlock()
	}
	return added, nil
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

// BumpSeq 递增本地 seq 并重新签名（邻居变化时调用）。
func (g *Gossip) BumpSeq() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.seq++
	return g.rebuildLocal()
}

// DescriptorCount 返回 LSDB 大小（诊断）。
func (g *Gossip) DescriptorCount() int {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return len(g.lsdb)
}
