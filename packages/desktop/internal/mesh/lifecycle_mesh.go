//go:build mesh

package mesh

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// meshLifecycle 是 +mesh 变体的真实生命周期（Phase 3b-2c 阶段 1c）。
//
// 编排流程（对齐 MobiHop node.rs 启动链）：
//  1. 建 UdpHub（单 socket，按源地址分解帧）
//  2. 建 TUN 设备（需管理员/root）
//  3. 对每个静态 peer 建 PeerLink + HandshakeFSM
//  4. 起收发循环：
//     - tun→peer：TUN 读 IP 包 → 查表定目标 → 无会话则触发握手 → 加密帧 → PeerLink.Send
//     - peer→tun：PeerLink.Recv → Handshake 帧交 FSM / Data 帧解密 → TUN.Send
//  5. Stop：关 TUN / UdpHub / 取消循环
type meshLifecycle struct {
	cfg       Config
	mu        sync.Mutex
	running   bool
	startedAt time.Time

	hub *UdpHub
	tun TunDevice
	// tunOverride 是外部注入的 TUN（Android VpnService 创建后传 fd）。
	// 非 nil 时 Start 直接用它，不再调平台 CreateTunDevice。
	tunOverride TunDevice
	fsm         *HandshakeFSM
	links       map[NodeID]PeerLink // peer -> PeerLink
	vipTable    *VirtualIPTable
	gossip      *Gossip // 描述符库：动态发现对端虚拟 IP（对齐 MobiHop Gossip）

	cancel context.CancelFunc
	wg     sync.WaitGroup

	txFrames  atomic.Uint64
	rxFrames  atomic.Uint64
	txDropped atomic.Uint64
	rxDropped atomic.Uint64
	hsOK      atomic.Uint64
	statsStop chan struct{}

	// 阶段 2：降级控制器与 UDP 探针
	degrade   *DegradeController
	probes    *ProbeTracker
	udpLinks  map[NodeID]PeerLink  // 保留原始 UDP 链路（回切用）
	recvLoops map[NodeID]*recvLoop // 每 peer 当前接收循环（切换时 cancel 旧起新）
}

type recvLoop struct {
	link   PeerLink
	cancel context.CancelFunc
	done   chan struct{}
}

// Stats 返回运行时统计（诊断用）。
func (m *meshLifecycle) Stats() (tx, rx, txDrop, rxDrop, hs uint64) {
	return m.txFrames.Load(), m.rxFrames.Load(), m.txDropped.Load(), m.rxDropped.Load(), m.hsOK.Load()
}

// NewLifecycle 返回 +mesh 变体的 Lifecycle 实现（使用默认空配置，需 SetConfig 注入）。
func NewLifecycle() Lifecycle { return &meshLifecycle{} }

// NewLifecycleWithConfig 用配置构造（桌面版/CLI 用）。
func NewLifecycleWithConfig(cfg Config) Lifecycle { return &meshLifecycle{cfg: cfg} }

// NewLifecycleWithTun 用配置 + 外部注入的 TUN 构造（Android VpnService 用）。
func NewLifecycleWithTun(cfg Config, tun TunDevice) Lifecycle {
	return &meshLifecycle{cfg: cfg, tunOverride: tun}
}

// SetConfig 注入配置（供 NewLifecycle 后用）。
func (m *meshLifecycle) SetConfig(cfg Config) { m.cfg = cfg }

func (m *meshLifecycle) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return fmt.Errorf("mesh: 已在运行")
	}
	if err := m.cfg.Validate(); err != nil {
		return err
	}

	// 1. 身份与网络
	// 优先用面板传入的密钥构造身份（对齐本地派生的 NodeId）；旧配置/CLI 缺密钥时回落到 tunnelKey。
	var ident *Identity
	var identitySeed [32]byte
	if len(m.cfg.IdentitySeed) == 32 && len(m.cfg.TunnelPrivate) == 32 {
		copy(identitySeed[:], m.cfg.IdentitySeed)
		var tunnelSeed [32]byte
		copy(tunnelSeed[:], m.cfg.TunnelPrivate)
		var idErr error
		ident, idErr = IdentityFromSeeds(identitySeed, tunnelSeed)
		if idErr != nil {
			return idErr
		}
		m.cfg.NodeID = ident.NodeID // 以身份派生为准，忽略手填值
	}
	network := DeriveNetworkID(m.cfg.NetworkName)
	psk := DerivePSK(m.cfg.NetworkName, m.cfg.PSK)
	tunnel, err := m.cfg.tunnelKey()
	if err != nil {
		return err
	}
	selfIP := net.ParseIP(m.cfg.VirtualIP)
	m.vipTable = NewVirtualIPTable(m.cfg.NodeID, selfIP)
	// Gossip：描述符签名需要身份私钥种子；缺种子（旧 CLI）时不启用动态发现
	if ident != nil {
		m.gossip, err = NewGossip(ident, m.cfg.VirtualIP)
		if err != nil {
			return err
		}
	}

	// 2. UdpHub（新 peer 发现后由回调建 link）
	var onIncoming func(NodeID, *net.UDPAddr)
	m.hub, err = NewUdpHub(m.cfg.Listen, func(id NodeID, addr *net.UDPAddr) {
		if onIncoming != nil {
			onIncoming(id, addr)
		}
	})
	if err != nil {
		return err
	}

	// 3. TUN（失败时关 hub）
	// Android VpnService 已在 Java 侧建好 TUN 并传 fd：用注入的 TunDevice，
	// 不再走平台 CreateTunDevice（它需要 root / 管理员，Android 上由 VpnService 授权）。
	if m.tunOverride != nil {
		m.tun = m.tunOverride
	} else {
		tunName := m.cfg.TunName
		if tunName == "" {
			tunName = "cfpilot0"
		}
		m.tun, err = CreateTunDevice(tunName, m.cfg.VirtualIP, m.cfg.MTU)
		if err != nil {
			_ = m.hub.Close()
			return err
		}
	}

	// 4. FSM（sendFn 经 peer 的 PeerLink 发帧）
	m.links = make(map[NodeID]PeerLink)
	m.recvLoops = make(map[NodeID]*recvLoop)
	m.fsm = NewHandshakeFSM(m.cfg.NodeID, network, psk, tunnel)
	m.fsm.SetOnEstablished(func(peer NodeID, sess *Session) {
		m.hsOK.Add(1)
		if m.cfg.Verbose {
			log.Printf("[mesh] 握手建立 peer=%x vip=%s epoch=%x", peer[:4], m.cfg.VirtualIP, sess.EpochID())
		}
	})
	m.fsm.SetSendFn(func(dst NodeID, frame []byte) error {
		link, ok := m.links[dst]
		if !ok {
			return fmt.Errorf("mesh: 到 %x 无链路", dst[:4])
		}
		return link.Send(context.Background(), frame)
	})

	// 5. 为每个静态 peer 建 link + 记录虚拟 IP（用 peer NodeID 派生的占位 IP 不便，留空由实际发现填）
	for _, p := range m.cfg.Peers {
		addr, err := net.ResolveUDPAddr("udp", p.Addr)
		if err != nil {
			_ = m.cleanupLocked()
			return err
		}
		m.links[p.NodeID] = m.hub.LinkTo(addr)
		m.vipTable.Add(net.ParseIP(p.VirtualIP), p.NodeID)
	}

	// 5b. 阶段 2：UDP 探针 + 降级控制器（仅 EnableDegrade 时）
	if m.cfg.EnableDegrade {
		m.udpLinks = make(map[NodeID]PeerLink, len(m.links))
		for id, link := range m.links {
			m.udpLinks[id] = link
		}
		m.probes = NewProbeTracker(m.hub, m.cfg.NodeID)
		for _, p := range m.cfg.Peers {
			addr, _ := net.ResolveUDPAddr("udp", p.Addr)
			m.probes.SetPeer(p.NodeID, addr)
		}
		m.degrade = NewDegradeController(m.cfg.NodeID, m.probes, m.cfg.RelayDomain, m.cfg.RelayRoom, nil, m.cfg.Verbose)
		for _, p := range m.cfg.Peers {
			m.degrade.AddPeer(p.NodeID, p.Addr)
		}
		// switchFn：切换 active link（nil kind=UDP 表示恢复原始 UDP link）
		m.degrade.SetSwitchFn(func(peer NodeID, link PeerLink, kind TransportKind) {
			m.mu.Lock()
			defer m.mu.Unlock()
			if kind == TransportWSS {
				if link != nil {
					m.links[peer] = link
				}
			} else {
				if udp, ok := m.udpLinks[peer]; ok {
					m.links[peer] = udp
				}
			}
		})
		m.degrade.SetCloseWssFn(func(peer NodeID) {
			m.mu.Lock()
			defer m.mu.Unlock()
			// 旧 WSS 由 controller 内部关闭；这里只清 active 引用（若有）
		})
	}

	// onIncoming：新 peer 自动建 link
	onIncoming = func(id NodeID, addr *net.UDPAddr) {
		m.mu.Lock()
		isNew := false
		if _, ok := m.links[id]; !ok {
			m.links[id] = m.hub.LinkTo(addr)
			isNew = true
		}
		link := m.links[id]
		m.mu.Unlock()
		// 新链路建立后立即发一次本地描述符（不等 5s tick），加速双向发现
		if isNew && m.gossip != nil {
			go func() {
				payload, err := m.gossip.GossipMessageBytes()
				if err != nil {
					return
				}
				var broadcast NodeID
				for i := range broadcast {
					broadcast[i] = 0xff
				}
				frame, err := (&Frame{Type: MsgGossip, TTL: DefaultTTL, Src: m.cfg.NodeID, Dst: broadcast, Payload: payload}).Encode()
				if err == nil {
					_ = link.Send(context.Background(), frame)
				}
			}()
		}
	}

	// 6. 起收发循环
	runCtx, cancel := context.WithCancel(ctx)
	m.cancel = cancel
	m.wg.Add(2)
	go m.tunToPeersLoop(runCtx)
	go m.peersToTunLoop(runCtx)
	if m.degrade != nil {
		// UdpProbe (0x08) 由 UdpHub.demux 直接交探针跟踪器（对齐 observe_probes），
		// 不进普通 peer 队列 —— 降级后 active=WSS 时 UDP 探针仍能被接收。
		m.hub.SetProbeHandler(func(frame []byte) {
			if m.probes != nil {
				_, _ = m.probes.OnProbeFrame(runCtx, frame)
			}
		})
		m.degrade.Start(runCtx)
		if m.cfg.Verbose {
			log.Printf("[mesh] 降级控制器已启动 relay=%s room=%s", m.cfg.RelayDomain, m.cfg.RelayRoom)
		}
	}
	// Gossip 广播：每 5s 把本地描述符发给所有已建链路，让对端动态得知本机虚拟 IP
	if m.gossip != nil {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-runCtx.Done():
					return
				case <-ticker.C:
					payload, err := m.gossip.GossipMessageBytes()
					if err != nil {
						continue
					}
					var broadcast NodeID
					for i := range broadcast {
						broadcast[i] = 0xff
					}
					frame, err := (&Frame{
						Type: MsgGossip, TTL: DefaultTTL,
						Src: m.cfg.NodeID, Dst: broadcast,
						Payload: payload,
					}).Encode()
					if err != nil {
						continue
					}
					m.mu.Lock()
					links := make([]PeerLink, 0, len(m.links))
					for _, link := range m.links {
						links = append(links, link)
					}
					m.mu.Unlock()
					for _, link := range links {
						_ = link.Send(runCtx, frame)
					}
				}
			}
		}()
	}
	if m.cfg.Verbose {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			ticker := time.NewTicker(3 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-runCtx.Done():
					return
				case <-ticker.C:
					tx, rx, td, rd, hs := m.Stats()
					probeInfo := ""
					if m.probes != nil {
						for _, p := range m.cfg.Peers {
							sent, pong, rtt := m.probes.Counters(p.NodeID)
							loss, samples, _ := m.probes.Measurement(p.NodeID)
							bad, good, cool := uint32(0), uint32(0), uint32(0)
							kindName := "?"
							if m.degrade != nil {
								bad, good, cool = m.degrade.PolicyCounters(p.NodeID)
								if m.degrade.Kind(p.NodeID) == TransportWSS {
									kindName = "wss"
								} else {
									kindName = "udp"
								}
							}
							probeInfo += fmt.Sprintf(" probe[%x]:sent=%d,pong=%d,rtt=%d,loss=%.2f,samples=%d,bad=%d,good=%d,cool=%d,kind=%s", p.NodeID[:4], sent, pong, rtt, loss, samples, bad, good, cool, kindName)
						}
					}
					log.Printf("[mesh] stats tx=%d rx=%d txDrop=%d rxDrop=%d handshakeOK=%d%s", tx, rx, td, rd, hs, probeInfo)
				}
			}
		}()
	}

	m.running = true
	m.startedAt = time.Now()
	if m.cfg.Verbose {
		log.Printf("[mesh] 节点已启动 node=%x vip=%s listen=%s peers=%d", m.cfg.NodeID[:4], m.cfg.VirtualIP, m.cfg.Listen, len(m.cfg.Peers))
	}
	return nil
}

// tunToPeersLoop：TUN 读 IP 包 → 加密 → PeerLink 发送。
func (m *meshLifecycle) tunToPeersLoop(ctx context.Context) {
	defer m.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		packet, err := m.tun.Recv(ctx)
		if err != nil || len(packet) == 0 {
			if err != nil && ctx.Err() == nil {
				time.Sleep(10 * time.Millisecond)
			}
			continue
		}
		dst, err := ParseDstAddr(packet)
		if err != nil {
			m.txDropped.Add(1)
			continue
		}
		peerID, _, ok := m.vipTable.Lookup(dst)
		if !ok {
			m.txDropped.Add(1)
			if m.cfg.Verbose && m.txDropped.Load()%20 == 1 {
				log.Printf("[mesh] 丢弃出站包：目的 %s 不在虚拟 IP 表", dst)
			}
			continue // 未知目标：丢弃（最小集，无子网网关）
		}
		// 确保会话（无则触发握手）
		sess, hasSession := m.fsm.Session(peerID)
		if !hasSession {
			link, ok := m.links[peerID]
			if !ok {
				continue
			}
			_ = link // 触发握手需要 peer 静态公钥，从配置取
			var peerStatic []byte
			for _, p := range m.cfg.Peers {
				if p.NodeID == peerID {
					peerStatic = p.StaticPub
					break
				}
			}
			if len(peerStatic) != 32 {
				continue
			}
			if err := m.fsm.StartOutbound(peerID, peerStatic); err != nil {
				continue
			}
			// 握手异步进行；首个包丢弃（对齐 MobiHop：queued 可缓存，最小集简化为丢弃）
			continue
		}
		frameBytes, err := Encapsulate(packet, m.cfg.NodeID, peerID, sess)
		if err != nil {
			continue
		}
		link, ok := m.links[peerID]
		if !ok {
			m.txDropped.Add(1)
			continue
		}
		if err := link.Send(ctx, frameBytes); err == nil {
			m.txFrames.Add(1)
		} else {
			m.txDropped.Add(1)
		}
	}
}

// peersToTunLoop：监控 active link 变化，为每个 peer 维护一个接收循环。
//
// 切换（UDP↔WSS）时 m.links[peer] 变化，本循环检测到后 cancel 旧 recv loop、
// 对新 link 起新 loop（对齐 MobiHop replace_link 递增 epoch 令旧 recv_loop 自退）。
func (m *meshLifecycle) peersToTunLoop(ctx context.Context) {
	defer m.wg.Done()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			m.stopAllRecvLoops()
			return
		case <-ticker.C:
			m.syncRecvLoops(ctx)
		}
	}
}

// syncRecvLoops 对比 m.links 与 recvLoops，起新停旧。
func (m *meshLifecycle) syncRecvLoops(ctx context.Context) {
	m.mu.Lock()
	type pair struct {
		id   NodeID
		link PeerLink
	}
	var start []pair
	var stop []NodeID
	for id, link := range m.links {
		loop := m.recvLoops[id]
		if loop == nil || loop.link != link {
			if loop != nil {
				stop = append(stop, id)
			}
			start = append(start, pair{id, link})
		}
	}
	m.mu.Unlock()

	for _, id := range stop {
		m.stopRecvLoop(id)
	}
	for _, p := range start {
		m.startRecvLoop(ctx, p.id, p.link)
	}
}

func (m *meshLifecycle) startRecvLoop(ctx context.Context, id NodeID, link PeerLink) {
	loopCtx, cancel := context.WithCancel(ctx)
	loop := &recvLoop{link: link, cancel: cancel, done: make(chan struct{})}
	m.mu.Lock()
	m.recvLoops[id] = loop
	m.mu.Unlock()
	go func() {
		defer close(loop.done)
		for {
			select {
			case <-loopCtx.Done():
				return
			default:
			}
			frame, err := link.Recv(loopCtx)
			if err != nil || len(frame) == 0 {
				if err != nil && loopCtx.Err() == nil {
					time.Sleep(10 * time.Millisecond)
				}
				continue
			}
			parsed, err := Decode(frame)
			if err != nil {
				continue
			}
			m.rxFrames.Add(1)
			if parsed.Type == MsgHandshake {
				if _, err := m.fsm.OnFrame(frame); err != nil && m.cfg.Verbose {
					log.Printf("[mesh] 握手帧处理失败: %v", err)
				}
				continue
			}
			if parsed.Type == MsgGossip {
				if m.gossip != nil {
					added, gerr := m.gossip.OnGossip(parsed.Payload)
					if gerr != nil && m.cfg.Verbose {
						log.Printf("[mesh] Gossip 处理失败: %v", gerr)
					}
					// 动态登记发现的对端虚拟 IP（一次链接双向自动发现的核心）
					for _, d := range added {
						if ip := d.VirtualIP(); ip != nil {
							m.vipTable.Add(ip, d.NodeID)
							if m.cfg.Verbose {
								log.Printf("[mesh] 发现对端 %s → %s", d.NodeID.Hex(), d.VirtualIPv4)
							}
						}
					}
				}
				continue
			}
			if parsed.Type == MsgUdpProbe {
				if m.probes != nil {
					_, _ = m.probes.OnProbeFrame(loopCtx, frame)
				}
				continue
			}
			var sess *Session
			for _, pid := range []NodeID{parsed.Src, id} {
				if s, ok := m.fsm.Session(pid); ok {
					sess = s
					break
				}
			}
			if sess == nil {
				continue
			}
			packet, err := Decapsulate(frame, m.cfg.NodeID, sess)
			if err != nil {
				continue
			}
			_ = m.tun.Send(loopCtx, packet)
		}
	}()
}

func (m *meshLifecycle) stopRecvLoop(id NodeID) {
	m.mu.Lock()
	loop := m.recvLoops[id]
	delete(m.recvLoops, id)
	m.mu.Unlock()
	if loop != nil {
		loop.cancel()
		select {
		case <-loop.done:
		case <-time.After(2 * time.Second):
		}
	}
}

func (m *meshLifecycle) stopAllRecvLoops() {
	m.mu.Lock()
	ids := make([]NodeID, 0, len(m.recvLoops))
	for id := range m.recvLoops {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.stopRecvLoop(id)
	}
}

func (m *meshLifecycle) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		return nil
	}
	if m.cancel != nil {
		m.cancel()
	}
	if m.degrade != nil {
		m.degrade.Stop()
	}
	m.wg.Wait()
	return m.cleanupLocked()
}

func (m *meshLifecycle) cleanupLocked() error {
	m.running = false
	if m.tun != nil {
		_ = m.tun.Close()
		m.tun = nil
	}
	if m.hub != nil {
		_ = m.hub.Close()
		m.hub = nil
	}
	m.links = nil
	return nil
}

func (m *meshLifecycle) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := Status{Running: m.running, Network: m.cfg.NetworkName, VirtualIP: m.cfg.VirtualIP, NodeID: fmt.Sprintf("%x", m.cfg.NodeID[:])}
	if m.running {
		st.UptimeSec = int64(time.Since(m.startedAt).Seconds())
	}
	for id := range m.links {
		online := false
		if _, ok := m.fsm.Session(id); ok {
			online = true
		}
		st.Peers = append(st.Peers, Peer{NodeID: fmt.Sprintf("%x", id[:]), Online: online})
	}
	if !m.running {
		st.Note = "+mesh 未运行"
	}
	return st
}
