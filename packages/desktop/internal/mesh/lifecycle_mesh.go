//go:build mesh

package mesh

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net"
	"sort"
	"strings"
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
	cfg         Config
	lifecycleMu sync.Mutex
	mu          sync.Mutex
	running     bool
	startedAt   time.Time

	hub      *UdpHub
	tun      TunDevice
	room     *WssRoom
	roomHash string
	runCtx   context.Context
	// tunOverride 是外部注入的 TUN（Android VpnService 创建后传 fd）。
	// 非 nil 时 Start 直接用它，不再调平台 CreateTunDevice。
	tunOverride TunDevice
	fsm         *HandshakeFSM
	links       map[NodeID]PeerLink // peer -> PeerLink
	peerStatic  map[NodeID][]byte   // verified peer tunnel public keys
	vipTable    *VirtualIPTable
	gossip      *Gossip // 描述符库：动态发现对端虚拟 IP（对齐 MobiHop Gossip）
	// lastOKRx 记录「最近一次成功解密该对端帧」的时刻，用于判定会话是否已失效。
	// 独立锁：Status 持有 m.mu 时会调 fsm.Session（拿 f.mu），
	// 握手回调持有 f.mu 时若再拿 m.mu 就会死锁，所以单独一把锁。
	rxMu     sync.Mutex
	lastOKRx map[NodeID]time.Time
	// lastTxData 记录最近一次**成功发出数据帧**的时刻。
	// 判定会话失效时必须同时看它：只有「我们在发数据、却长时间收不到可解密帧」
	// 才重置；健康但空闲的会话不能被误拆。
	txMu       sync.Mutex
	lastTxData map[NodeID]time.Time

	// STUN 探测结果（启动后后台异步更新；不阻断组网）。
	natMu sync.Mutex
	nat   NatAssessment
	// 中继地址、节点和当前心跳状态由独立锁保护。
	relayMu        sync.Mutex
	relayEndpoints map[string]*relayEndpoint

	// P3 打洞编排状态（每个对端一份）。
	punchMu sync.Mutex
	punch   map[NodeID]*punchRun
	// probeBackSent 记录已回发过 probe-back 的 (peer|nonce)：
	// 两端互探必须去重，否则形成探测风暴。
	probeBackSent map[string]struct{}
	// hardSymCursor 是硬对称洗牌扫描的游标（每对端一份，跨轮推进、不重复端口）。
	hardSymCursor map[NodeID]uint32

	// wireVersions 记录每个对端的线速版本（ADR-0016）：控制帧与数据帧都按它编码。
	// 只从能成功解码的入站帧学习，未知对端按 v2。
	wireVersions *PeerWireVersions

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
}

// Stats 返回运行时统计（诊断用）。
func (m *meshLifecycle) Stats() (tx, rx, txDrop, rxDrop, hs uint64) {
	return m.txFrames.Load(), m.rxFrames.Load(), m.txDropped.Load(), m.rxDropped.Load(), m.hsOK.Load()
}

// wireVersionFor 返回发给某对端的线速版本（未初始化/未知时用默认 v2）。
func (m *meshLifecycle) wireVersionFor(id NodeID) byte {
	if m.wireVersions == nil {
		return WireVersionDefault
	}
	return m.wireVersions.VersionFor(id)
}

// markOKRx 记录一次「成功解密」的时刻（会话活性判据）。
func (m *meshLifecycle) markOKRx(id NodeID) {
	m.rxMu.Lock()
	if m.lastOKRx != nil {
		m.lastOKRx[id] = time.Now()
	}
	m.rxMu.Unlock()
}

// sinceOKRx 返回距上次成功解密的时间；从未成功过返回极大值。
func (m *meshLifecycle) sinceOKRx(id NodeID) time.Duration {
	m.rxMu.Lock()
	defer m.rxMu.Unlock()
	if t, ok := m.lastOKRx[id]; ok {
		return time.Since(t)
	}
	return 1 << 62
}

// markTxData 记录一次成功的数据帧发送（会话活性判据的另一半）。
func (m *meshLifecycle) markTxData(id NodeID) {
	m.txMu.Lock()
	if m.lastTxData != nil {
		m.lastTxData[id] = time.Now()
	}
	m.txMu.Unlock()
}

// sinceTxData 返回距上次成功发送数据帧的时间；从未发过返回极大值。
func (m *meshLifecycle) sinceTxData(id NodeID) time.Duration {
	m.txMu.Lock()
	defer m.txMu.Unlock()
	if t, ok := m.lastTxData[id]; ok {
		return time.Since(t)
	}
	return 1 << 62
}

// learnWireVersion 从**解码成功**的入站帧学习对端版本（ADR-0016 协商纪律）。
func (m *meshLifecycle) learnWireVersion(src NodeID, version byte) {
	if m.wireVersions != nil {
		m.wireVersions.Learn(src, version)
	}
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
	return m.start(ctx, m.dialWssRoom)
}

func (m *meshLifecycle) start(ctx context.Context, dialRoom func(context.Context) (*WssRoom, error)) error {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return fmt.Errorf("mesh: 已在运行")
	}
	if err := m.cfg.Validate(); err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
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
	m.roomHash = ""
	if m.cfg.RelayDomain != "" {
		m.roomHash = ResolveRelayRoomHash(m.cfg.RelayRoom, psk)
	}
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

	resolveCtx, stopResolving := context.WithTimeout(ctx, 5*time.Second)
	defer stopResolving()
	bindAddr, err := resolveMeshUDPAddr(resolveCtx, 0, m.cfg.Listen)
	if err != nil {
		return fmt.Errorf("mesh: 解析 UDP 监听地址失败: %w", err)
	}
	seedAddrs := make(map[NodeID]*net.UDPAddr, len(m.cfg.Peers))
	for _, peer := range m.cfg.Peers {
		addr, err := resolveMeshUDPAddr(resolveCtx, 0, peer.Addr)
		if err != nil {
			return fmt.Errorf("mesh: 解析对端地址失败: %w", err)
		}
		seedAddrs[peer.NodeID] = addr
	}
	stopResolving()
	if err := ctx.Err(); err != nil {
		return err
	}
	// 双栈默认开启，监听地址为通配地址时由同一个 socket 接收 IPv4 与 IPv6。
	m.hub, err = NewUdpHubWithDual(bindAddr.String(), !m.cfg.DisableListenDual, nil)
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
			m.hub = nil
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		_ = m.hub.Close()
		_ = m.tun.Close()
		m.hub, m.tun = nil, nil
		return err
	}
	runCtx, cancel := context.WithCancel(ctx)
	m.cancel = cancel
	m.runCtx = runCtx

	// 4. FSM（sendFn 经 peer 的 PeerLink 发帧）
	m.links = make(map[NodeID]PeerLink)
	m.peerStatic = make(map[NodeID][]byte)
	m.recvLoops = make(map[NodeID]*recvLoop)
	// 线速版本登记表：FSM / 探针 / 数据面共用一个实例，保证「学到 v1 后全部降级」。
	m.wireVersions = NewPeerWireVersions()
	m.lastOKRx = make(map[NodeID]time.Time)
	m.lastTxData = make(map[NodeID]time.Time)
	m.punch = make(map[NodeID]*punchRun)
	m.relayEndpoints = make(map[string]*relayEndpoint)
	m.probeBackSent = make(map[string]struct{})
	m.hardSymCursor = make(map[NodeID]uint32)
	m.fsm = NewHandshakeFSM(m.cfg.NodeID, network, psk, tunnel)
	m.fsm.SetWireVersions(m.wireVersions)
	m.fsm.SetOnEstablished(func(peer NodeID, sess *Session) {
		m.hsOK.Add(1)
		m.markOKRx(peer)
		go func() {
			// Defer map access until the FSM lock has been released.
			if link := m.linkForPeer(peer); link != nil && link.IsRelayed() && !m.cfg.DisablePunch {
				m.startPunch(peer, link)
			}
			if m.cfg.Verbose {
				log.Printf("[mesh] 握手建立 peer=%x vip=%s epoch=%x", peer[:4], m.cfg.VirtualIP, sess.EpochID())
			}
		}()
	})
	m.fsm.SetSendFn(func(dst NodeID, frame []byte) error {
		link := m.linkForPeer(dst)
		if link == nil {
			return fmt.Errorf("mesh: 到 %x 无链路", dst[:4])
		}
		return link.Send(runCtx, frame)
	})

	// 5. 为每个静态 peer 建 link + 记录虚拟 IP（用 peer NodeID 派生的占位 IP 不便，留空由实际发现填）
	for _, p := range m.cfg.Peers {
		m.links[p.NodeID] = m.hub.LinkTo(seedAddrs[p.NodeID])
		m.peerStatic[p.NodeID] = append([]byte(nil), p.StaticPub...)
		m.vipTable.Add(net.ParseIP(p.VirtualIP), p.NodeID)
	}
	m.udpLinks = make(map[NodeID]PeerLink, len(m.links))
	for id, link := range m.links {
		m.udpLinks[id] = link
	}

	// 5b. UDP 探针：**始终开启**（不只降级时）。
	// 它同时承担三件事：给面板提供真实 RTT/丢包、给 NAT 打洞保活、让对端学到我们的地址。
	// 早前只在 EnableDegrade 时创建，普通模式下界面上永远是 0ms/无数据。
	m.probes = NewProbeTracker(m.hub, m.cfg.NodeID)
	m.probes.SetWireVersionProvider(m.wireVersionFor)
	for _, p := range m.cfg.Peers {
		m.probes.SetPeer(p.NodeID, seedAddrs[p.NodeID])
	}
	// 阶段 2：降级控制器（启用自动降级或盲中继房间时）
	if m.cfg.EnableDegrade || m.cfg.RelayDomain != "" {
		m.degrade = NewDegradeController(m.cfg.NodeID, m.probes, m.cfg.RelayDomain, m.cfg.RelayRoom, m.cfg.RelayConnectIP, nil, m.cfg.Verbose)
		for _, p := range m.cfg.Peers {
			m.degrade.AddPeer(p.NodeID, p.Addr)
		}
		m.degrade.SetSharedWssRoomRequired(m.cfg.RelayDomain != "")
		// switchFn：切换 active link（nil kind=UDP 表示恢复原始 UDP link）
		m.degrade.SetSwitchFn(func(peer NodeID, link PeerLink, kind TransportKind) {
			m.mu.Lock()
			if runCtx.Err() != nil || m.degrade.IsDirectLocked(peer) {
				m.mu.Unlock()
				return
			}
			if kind == TransportWSS {
				if shared, ok := link.(*WssRoomPeer); ok && shared.room != m.room {
					m.mu.Unlock()
					return
				}
				if link != nil {
					m.links[peer] = link
				}
			} else {
				if udp, ok := m.udpLinks[peer]; ok {
					m.links[peer] = udp
				}
			}
			active := m.links[peer]
			m.mu.Unlock()
			if active == nil {
				return
			}
			// ⚠️ 关键：切换链路后必须**重启该 peer 的接收循环**，否则旧循环还绑在
			// 原来的 UDP link 上，WSS 上收到的握手帧永远没人读（handshakeOK 恒 0）。
			m.syncRecvLoops(runCtx)
			// 新链路上重发 Init（打洞/中继建立后双方都需要重新握手）。
			if _, ok := m.fsm.Session(peer); !ok {
				if pub := m.peerStaticKey(peer); len(pub) == 32 {
					_ = m.fsm.StartOutbound(peer, pub)
				}
			}
			// ⚠️ 切到 WSS（中继）后必须主动打洞：
			// 若会话最初在 UDP 阶段建立，onEstablished 回调时 link 还不是 relayed，
			// 那次不会触发 startPunch；而 UDP 不通才降级到 WSS，正是最需要打洞的时候。
			if kind == TransportWSS && m.fsm.HasSession(peer) {
				m.startPunch(peer, active)
			}
			if m.cfg.Verbose {
				log.Printf("[mesh] 链路切换完成 peer=%x kind=%v，接收循环已重启", peer[:4], kind)
			}
		})
	}

	// onIncoming：新 peer 自动建 link
	m.hub.setIncomingHandler(func(id NodeID, addr *net.UDPAddr) {
		m.mu.Lock()
		if runCtx.Err() != nil || m.isVirtualMeshIP(addr.IP) {
			m.mu.Unlock()
			return
		}
		isNew := false
		if cur, ok := m.links[id]; !ok {
			m.links[id] = m.hub.LinkTo(addr)
			isNew = true
		} else if cur.IsRelayed() {
			// 收到来自该对端**新地址**的帧，证明直连可达（打洞/NAT 重绑定）：
			// 把中继腿换成这个 hubLink，recv 循环会随 m.links 自动重建。
			m.links[id] = m.hub.LinkTo(addr)
			isNew = true
			if m.degrade != nil {
				m.degrade.LockDirect(id)
			}
			if m.cfg.Verbose {
				log.Printf("[mesh] 对端 %x 直连地址可达，从中继切换：%s", id[:4], addr)
			}
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
				frame, err := (&Frame{
					Version: m.wireVersionFor(id),
					Type:    MsgGossip, TTL: DefaultTTL,
					Src: m.cfg.NodeID, Dst: broadcast, Payload: payload,
				}).Encode()
				if err == nil {
					_ = link.Send(runCtx, frame)
				}
			}()
		}
	})

	// 6. 起收发循环
	m.wg.Add(2)
	go m.tunToPeersLoop(runCtx)
	go m.peersToTunLoop(runCtx)
	if configurer, ok := m.tun.(interface{ configureNetwork(context.Context) }); ok {
		m.wg.Go(func() { configurer.configureNetwork(runCtx) })
	}
	if m.roomConfigured() {
		m.wg.Go(func() { m.reconnectWssRoom(runCtx, dialRoom) })
		m.wg.Add(1)
		go m.roomGossipLoop(runCtx)
	}

	// 6.0a STUN 探测（后台异步，失败只记状态）：跨 NAT 的第一步。
	// 必须复用 m.hub 的 socket —— 换 socket 会拿到不同 NAT 映射，打洞端口对不上。
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		if len(m.cfg.StunServers) == 0 {
			m.natMu.Lock()
			m.nat = NatAssessment{Type: "Unknown"}
			m.natMu.Unlock()
			return
		}
		timeout := time.Duration(m.cfg.StunProbeTimeoutMS) * time.Millisecond
		// 第一轮 IPv4：NAT 类型语义只对 v4 有意义（对称/锥形）。
		nat4 := DiscoverNatFamily(runCtx, m.hub, m.cfg.StunServers, timeout, 4)
		m.natMu.Lock()
		m.nat = nat4
		m.natMu.Unlock()
		// 第二轮 IPv6：只为了拿反射地址（无 NAT 即本机全球地址），
		// 它是「免端口映射直连」的直接依据。失败不降级也不报错。
		nat6 := DiscoverNatFamily(runCtx, m.hub, m.cfg.StunServers, timeout, 6)
		if nat6.Reflexive6 != "" {
			nat4.Reflexive6 = nat6.Reflexive6
		}
		m.natMu.Lock()
		m.nat = nat4
		m.natMu.Unlock()
		if m.cfg.Verbose {
			log.Printf("[mesh] STUN 探测完成 nat=%s reflexive=%s reflexive6=%s",
				nat4.Type, nat4.Reflexive, nat4.Reflexive6)
		}
	}()

	// UdpProbe (0x08) 由 UdpHub.demux 直接交探针跟踪器（对齐 observe_probes），
	// 不进普通 peer 队列 —— 降级后 active=WSS 时 UDP 探针仍能被接收。
	// **始终注册**：普通模式也要靠它算 RTT / 打洞保活。
	m.hub.SetProbeHandler(func(frame []byte) {
		if m.probes == nil {
			return
		}
		if parsed, derr := Decode(frame); derr == nil {
			m.learnWireVersion(parsed.Src, parsed.Version)
		}
		_, _ = m.probes.OnProbeFrame(runCtx, frame)
	})

	// 控制帧（HolePunch / RelayMgmt）的独立入站观察通道：在 demux 分流前按真实源地址处理，
	// 与活跃链路无关（MobiHop hub.rs:386-393 / CROSS_PROJECT_SYNC §11.5）。
	// 这是打洞探测与中继注册应答能被处理的关键 —— 之前塞在活跃 link 的 recv 队列里，
	// 切 WSS 后 UDP 探测就没人读了。
	m.hub.SetControlHandler(func(remote *net.UDPAddr, frame []byte) {
		parsed, derr := Decode(frame)
		if derr != nil {
			return
		}
		m.learnWireVersion(parsed.Src, parsed.Version)
		switch parsed.Type {
		case MsgHolePunch:
			m.handlePunch(parsed.Src, parsed, remote)
		case MsgRelayMgmt:
			m.handleRelayMgmt(parsed, remote)
		}
	})

	m.spawnRelayClients(runCtx, DeriveRoomTag(psk))

	// 6a. 启动即主动握手：UDP 无连接，双方都只「等对方先发包」就会永远无事发生。
	// 小 NodeId 一方作为发起方直接发 Init（对齐 FSM 的破对称角色），
	// 非发起方等对端 Init；对端没起来时由 RetryPending 周期重发。
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		for _, p := range m.cfg.Peers {
			if !m.fsm.IsInitiator(p.NodeID) {
				continue
			}
			if err := m.fsm.StartOutbound(p.NodeID, p.StaticPub); err != nil && m.cfg.Verbose {
				log.Printf("[mesh] 主动握手失败 peer=%x: %v", p.NodeID[:4], err)
			}
		}
	}()

	// 6b. 探针循环（1s）：给面板 RTT、给 NAT 保活、让对端从首帧学地址。
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				m.mu.Lock()
				pairs := make(map[NodeID]*net.UDPAddr, len(m.links))
				for id, link := range m.links {
					if addr := link.PeerAddr(); addr != nil {
						pairs[id] = addr
					}
				}
				m.mu.Unlock()
				for id, addr := range pairs {
					m.probes.SetPeer(id, addr)
					// 发送失败必须可见：旧实现丢掉错误，于是「对端地址不可达 / 地址族不匹配」
					// 只会表现为「探针一直 loss=1」，完全看不出是发不出去还是收不到。
					if _, err := m.probes.SendProbe(runCtx, id); err != nil && m.cfg.Verbose {
						log.Printf("[mesh] UDP 探针发送失败 peer=%x addr=%s: %v", id[:4], addr, err)
					}
				}
			}
		}
	}()

	if m.degrade != nil {
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
					// ⚠️ 版本必须**按对端**分别编码：广播帧只有头字节不同，
					// 但混合集群里 v1 节点会丢弃 0x02 帧（Gossip 收不到 ⇒ 拓扑永远不收敛）。
					m.mu.Lock()
					type peerLink struct {
						id   NodeID
						link PeerLink
					}
					pairs := make([]peerLink, 0, len(m.links))
					for id, link := range m.links {
						pairs = append(pairs, peerLink{id, link})
					}
					m.mu.Unlock()
					for _, p := range pairs {
						frame, ferr := (&Frame{
							Version: m.wireVersionFor(p.id),
							Type:    MsgGossip, TTL: DefaultTTL,
							Src: m.cfg.NodeID, Dst: broadcast,
							Payload: payload,
						}).Encode()
						if ferr != nil {
							continue
						}
						_ = p.link.Send(runCtx, frame)
					}
				}
			}
		}()
	}
	// 握手降级兜底（ADR-0016 / session.rs:1452）：
	// 发出 Init 后 5 s 仍**从未收到该对端任何帧** → 用同一份 Init 载荷以 v1 重发，
	// 并把该对端置 v1。没有这条兜底，v1 对端会永远解不开我们的 v2 Init。
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				m.fsm.RetryPending(time.Now(), 5*time.Second)
			}
		}
	}()

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

func (m *meshLifecycle) dialWssRoom(ctx context.Context) (*WssRoom, error) {
	url, err := RelayRoomURL(m.cfg.RelayDomain, m.roomHash, m.cfg.NodeID.Hex())
	if err != nil {
		return nil, err
	}
	parsed, err := ParseWsUrl(url)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(m.cfg.RelayConnectIP) != "" {
		parsed = parsed.WithConnectIP(m.cfg.RelayConnectIP)
	}
	conn, err := DialWss(ctx, parsed, nil)
	if err != nil {
		return nil, err
	}
	return NewWssRoom(conn, m.cfg.NodeID), nil
}

// installWssRoomLocked 只更新链路引用，不在状态锁内执行网络 I/O。
func (m *meshLifecycle) installWssRoomLocked(ctx context.Context, room *WssRoom) []NodeID {
	m.room = room
	var relayed []NodeID
	if m.degrade != nil {
		m.degrade.SetWssRoom(room)
	}
	for id := range m.peerStatic {
		current := m.links[id]
		if current != nil && !current.IsRelayed() && m.fsm.HasSession(id) {
			continue
		}
		m.links[id] = room.Link(id)
		relayed = append(relayed, id)
		if m.degrade != nil {
			m.degrade.AddPeerWithoutUDP(id, TransportWSS)
		}
	}
	room.SetPeerHandler(func(id NodeID, link PeerLink) {
		m.mu.Lock()
		if ctx.Err() != nil || m.room != room || id == m.cfg.NodeID {
			m.mu.Unlock()
			return
		}
		if current := m.links[id]; current == nil || current.IsRelayed() {
			m.links[id] = link
		}
		m.mu.Unlock()
	})
	room.Start(ctx)
	return relayed
}

func (m *meshLifecycle) reconnectWssRoom(ctx context.Context, dialRoom func(context.Context) (*WssRoom, error)) {
	for ctx.Err() == nil {
		next, err := dialRoom(ctx)
		if err != nil {
			if m.cfg.Verbose && ctx.Err() == nil {
				log.Printf("[mesh] 连接盲中继失败，将重试: %v", err)
			}
		} else {
			m.mu.Lock()
			if ctx.Err() != nil {
				m.mu.Unlock()
				_ = next.Close()
				return
			}
			old := m.room
			relayed := m.installWssRoomLocked(ctx, next)
			m.mu.Unlock()
			if old != nil {
				_ = old.Close()
			}
			m.syncRecvLoops(ctx)
			m.sendRoomGossip(ctx, next)
			for _, id := range relayed {
				if m.fsm.HasSession(id) {
					m.startPunch(id, next.Link(id))
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-next.done:
				m.resumeUDPRelay(ctx)
			}
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (m *meshLifecycle) roomGossipLoop(ctx context.Context) {
	defer m.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		m.mu.Lock()
		room := m.room
		m.mu.Unlock()
		m.sendRoomGossip(ctx, room)
	}
}

func (m *meshLifecycle) sendRoomGossip(ctx context.Context, room *WssRoom) {
	if room == nil || m.gossip == nil {
		return
	}
	payload, err := m.gossip.GossipMessageBytes()
	if err != nil {
		return
	}
	frame, err := (&Frame{
		Version: WireVersionDefault, Type: MsgGossip, TTL: DefaultTTL,
		Src: m.cfg.NodeID, Dst: broadcastNodeID(), Payload: payload,
	}).Encode()
	if err == nil {
		_ = room.Link(m.cfg.NodeID).Send(ctx, frame)
	}
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
		peerID, isBroadcast, ok := m.vipTable.Lookup(dst)
		if ok && isBroadcast {
			// 虚拟网段广播（Windows 上会周期性出现 10.97.0.255）暂不支持转发：
			// 静默忽略、不计数 —— 否则状态面板长期显示「丢弃 12」，
			// 用户会误以为链路有问题。
			continue
		}
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
			link := m.linkForPeer(peerID)
			if link == nil {
				continue
			}
			peerStatic := m.peerStaticKey(peerID)
			if len(peerStatic) != 32 {
				continue
			}
			// 需要发数据但还没有会话 ⇒ 强制发起（忽略破对称角色）：
			// 对端可能持有我们重启前的旧会话，它不会主动重来，只能由我们发 Init 触发重建。
			if err := m.fsm.StartOutboundForce(peerID, peerStatic); err != nil {
				continue
			}
			// 握手异步进行；首个包丢弃（对齐 MobiHop：queued 可缓存，最小集简化为丢弃）
			continue
		}
		frameBytes, err := Encapsulate(packet, m.cfg.NodeID, peerID, sess, m.wireVersionFor(peerID))
		if err != nil {
			continue
		}
		link := m.linkForPeer(peerID)
		if link == nil {
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
			return
		case <-ticker.C:
			m.syncRecvLoops(ctx)
		}
	}
}

// syncRecvLoops 对比 m.links 与 recvLoops，起新停旧。
func (m *meshLifecycle) syncRecvLoops(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ctx.Err() != nil {
		return
	}
	for id, link := range m.links {
		if loop := m.recvLoops[id]; loop != nil {
			if loop.link == link {
				continue
			}
			loop.cancel()
		}
		loopCtx, cancel := context.WithCancel(ctx)
		m.recvLoops[id] = &recvLoop{link: link, cancel: cancel}
		m.wg.Go(func() { m.recvFromPeer(loopCtx, id, link) })
	}
}

// peerConfig 按 NodeID 查静态对端配置（用于链路切换后重发握手）。
func (m *meshLifecycle) peerConfig(id NodeID) *PeerConfig {
	for i := range m.cfg.Peers {
		if m.cfg.Peers[i].NodeID == id {
			return &m.cfg.Peers[i]
		}
	}
	return nil
}

func (m *meshLifecycle) peerStaticKey(id NodeID) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]byte(nil), m.peerStatic[id]...)
}

// lookupPeerVirtualIP 返回签名 Gossip 描述符登记的对端虚拟 IP。
// 独立函数避免在 Status() 中重复 nil 判断，也减少与 gossip 内部锁的耦合。
func (m *meshLifecycle) lookupPeerVirtualIP(id NodeID) (string, bool) {
	if m.gossip == nil {
		return "", false
	}
	return m.gossip.LookupVirtualIP(id)
}

func printablePeerName(raw string) string {
	var out strings.Builder
	for _, r := range strings.TrimSpace(raw) {
		if r < 32 || r == 127 || r == 0xfffd {
			continue
		}
		out.WriteRune(r)
	}
	return strings.TrimSpace(out.String())
}

func (m *meshLifecycle) roomConfigured() bool {
	return strings.TrimSpace(m.cfg.RelayDomain) != "" && strings.TrimSpace(m.roomHash) != ""
}

func (m *meshLifecycle) linkForPeer(id NodeID) PeerLink {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.links[id]
}

func (m *meshLifecycle) registerDiscoveredPeer(d NodeDescriptor) {
	if d.NodeID == m.cfg.NodeID || len(d.TunnelPub) != 32 || d.Verify() != nil {
		return
	}
	pub := append([]byte(nil), d.TunnelPub[:]...)
	m.mu.Lock()
	if previous := m.peerStatic[d.NodeID]; len(previous) == 32 && !bytes.Equal(previous, pub) {
		m.mu.Unlock()
		return
	}
	m.peerStatic[d.NodeID] = pub
	vip := d.VirtualIP()
	if vip != nil {
		if cfg := m.peerConfig(d.NodeID); cfg != nil {
			if old := net.ParseIP(cfg.VirtualIP); old != nil && !old.Equal(vip) {
				log.Printf("[mesh] 对端 %x 虚拟 IP 与静态配置不一致：配置=%s 描述符=%s，按签名描述符修正路由",
					d.NodeID[:4], cfg.VirtualIP, vip.String())
			}
		}
	}
	link := m.links[d.NodeID]
	if link == nil && m.room != nil {
		link = m.room.Link(d.NodeID)
		m.links[d.NodeID] = link
	}
	m.mu.Unlock()
	if vip != nil {
		m.vipTable.Add(vip, d.NodeID)
	}
	if m.degrade != nil && peerTransportName(link) == "wss" {
		m.degrade.AddPeerWithoutUDP(d.NodeID, TransportWSS)
	}
	if lessNodeID(m.cfg.NodeID, d.NodeID) {
		if err := m.fsm.StartOutbound(d.NodeID, pub); err != nil && m.cfg.Verbose {
			log.Printf("[mesh] 发现对端后发起握手失败 peer=%x: %v", d.NodeID[:4], err)
		}
	}
}

func (m *meshLifecycle) recvFromPeer(loopCtx context.Context, id NodeID, link PeerLink) {
	for {
		select {
		case <-loopCtx.Done():
			return
		default:
		}
		frame, err := link.Recv(loopCtx)
		if loopCtx.Err() != nil {
			return
		}
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
		// 任何从该 peer 链路成功解出的帧都是「链路活着」的证据 —— 不能只在
		// Decapsulate 成功后才 markOKRx：经中继的链路在没有业务数据时只有周期
		// Gossip，面板会一直显示「已断开（无响应）」而实际 ping 全通（真机）。
		// 只认本循环所属的 peer（不用帧头 src，避免同房间冒名改写别人状态）。
		m.markOKRx(id)
		// 解码成功才学习版本（v1 已过 buf[5]==0 校验）；伪造帧最多让本机降级。
		m.learnWireVersion(parsed.Src, parsed.Version)
		// HolePunch 在 UDP 上由 UdpHub 的独立观察通道处理；但在 WSS 房间里
		// 没有 UDP 源地址，必须在链路 recv 循环里处理 PunchReq/PunchReply，
		// 否则「经 WSS 的中继会话」永远无法发起打洞（真机症状：一直中继）。
		// 探测类帧（PunchProbe/Ack）仍要求真实 UDP 源地址，handlePunch 会忽略 nil remote。
		if parsed.Type == MsgHolePunch {
			m.handlePunch(parsed.Src, parsed, nil)
			continue
		}
		if parsed.Type == MsgRelayMgmt {
			continue
		}
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
					m.registerDiscoveredPeer(d)
					if m.cfg.Verbose {
						log.Printf("[mesh] 发现对端 %s → %s", d.NodeID.Hex(), d.VirtualIPv4)
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
		m.markOKRx(parsed.Src)
		_ = m.tun.Send(loopCtx, packet)
	}
}

func (m *meshLifecycle) Stop() error {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return nil
	}
	tun, hub, degrade := m.tun, m.hub, m.degrade
	room := m.room
	m.cancel()
	m.mu.Unlock()

	// 关闭传输以唤醒尚在读写的任务，再等待退出，期间不持状态锁。
	if room != nil {
		_ = room.Close()
	}
	if hub != nil {
		_ = hub.Close()
	}
	if tun != nil {
		_ = tun.Close()
	}
	if degrade != nil {
		degrade.Stop()
	}
	m.wg.Wait()

	m.mu.Lock()
	m.running = false
	m.tun = nil
	m.hub = nil
	m.room = nil
	m.links = nil
	m.recvLoops = nil
	m.degrade = nil
	m.mu.Unlock()
	return nil
}

func (m *meshLifecycle) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.natMu.Lock()
	nat := m.nat
	m.natMu.Unlock()
	st := Status{
		Running:     m.running,
		NatType:     nat.Type,
		Reflexive:   nat.Reflexive,
		Reflexive6:  nat.Reflexive6,
		Network:     m.cfg.NetworkName,
		VirtualIP:   m.cfg.VirtualIP,
		NodeID:      fmt.Sprintf("%x", m.cfg.NodeID[:]),
		Listen:      listenActual(m.cfg.Listen, m.hub),
		TXFrames:    m.txFrames.Load(),
		RXFrames:    m.rxFrames.Load(),
		TXDropped:   m.txDropped.Load(),
		RXDropped:   m.rxDropped.Load(),
		HandshakeOK: m.hsOK.Load(),
	}
	if m.running {
		st.UptimeSec = int64(time.Since(m.startedAt).Seconds())
	} else {
		st.Note = "+mesh 未运行"
		return st
	}

	// 先列**配置里的对端**（即使还没建链路），否则用户看到的是空列表，
	// 完全不知道自己在等谁。再按实际链路/会话补充地址与状态。
	type peerView struct {
		peer Peer
		set  bool
	}
	views := make(map[NodeID]*peerView)
	for _, p := range m.cfg.Peers {
		vip := p.VirtualIP
		if discovered, ok := m.lookupPeerVirtualIP(p.NodeID); ok && discovered != "" {
			// 签名描述符是运行时权威值：静态配置里的旧网段只应作为未发现时的兜底。
			vip = discovered
		}
		if vip == "" {
			if discovered, ok := m.lookupPeerVirtualIP(p.NodeID); ok {
				vip = discovered
			}
		}
		v := &peerView{peer: Peer{
			NodeID:    p.NodeID.Hex(),
			VirtualIP: vip,
			Addr:      p.Addr,
			State:     "等待对端",
			Via:       "udp",
			Name:      printablePeerName(p.Name),
		}, set: true}
		views[p.NodeID] = v
	}
	for id, link := range m.links {
		v := views[id]
		if v == nil {
			vip := ""
			if discovered, ok := m.lookupPeerVirtualIP(id); ok && discovered != "" {
				vip = discovered
			}
			if discovered, ok := m.lookupPeerVirtualIP(id); ok {
				vip = discovered
			}
			v = &peerView{peer: Peer{NodeID: id.Hex(), VirtualIP: vip, Via: "udp", State: "等待对端"}, set: true}
			views[id] = v
		}
		if addr := link.PeerAddr(); addr != nil && v.peer.Addr == "" {
			v.peer.Addr = addr.String()
		}
	}

	for id, v := range views {
		p := &v.peer
		// 会话状态：已连接 / 已断开（无响应）/ 握手中 / 未连接（仅配置）
		if _, ok := m.fsm.Session(id); ok {
			// 有会话不等于还活着：对端停止组网后我们仍持有旧会话。
			// 判据：15s 内既没收到可解密帧、也没收到探针 Pong ⇒ 实际已失联。
			pongAge := time.Duration(1 << 62)
			if m.probes != nil {
				pongAge = m.probes.LastPongAge(id)
			}
			if m.sinceOKRx(id) < 15*time.Second || pongAge < 15*time.Second {
				p.Online = true
				p.State = "已连接"
			} else {
				p.Online = false
				p.State = "已断开（无响应）"
			}
		} else if hs := m.fsm.State(id); hs != HSIdle {
			p.State = "握手中"
		} else {
			p.State = "未连接（仅配置）"
		}
		// 传输档位：经中继转发 / 降级到 WSS 都要明确标出来
		// （直连假活、却其实走中继时，用户最需要看这个）。
		p.Via = peerTransportName(m.links[id])
		p.PunchState, p.PunchKind = m.punchState(id)
		if p.PunchKind == "port-predict" {
			// 硬对称扫描由状态机在探测阶段内部执行，当前用 stun + 端口预测概括。
			p.PunchKind = "stun+预测端口"
		}
		// 探针实测 RTT / 丢包（样本不足时 Measurement 返回 0，不误报）
		if m.probes != nil {
			loss, _, rtt := m.probes.Measurement(id)
			p.LossRate = loss
			p.RTTMs = int64(rtt)
		}
		st.Peers = append(st.Peers, *p)
	}
	// 输出顺序固定（NodeID 升序），便于界面与日志对比
	sort.Slice(st.Peers, func(i, j int) bool { return st.Peers[i].NodeID < st.Peers[j].NodeID })

	if st.HandshakeOK == 0 {
		st.Note = "尚无任何对端完成握手：确认两端网络名/PSK 一致、对端 UDP 地址可达、防火墙放行"
	}
	return st
}

func peerTransportName(link PeerLink) string {
	switch link.(type) {
	case nil:
		return ""
	case *WssRoomPeer, *WssLink:
		return "wss"
	}
	if link.IsRelayed() {
		return "relay"
	}
	if addr := link.PeerAddr(); addr != nil && addr.IP.To4() == nil {
		return "udp6"
	}
	return "udp4"
}
