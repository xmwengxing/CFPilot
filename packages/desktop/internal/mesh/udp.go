package mesh

import (
	"context"
	"fmt"
	"net"
	"sync"
	"syscall"
	"time"
)

// UdpHub 是单 UDP socket 多路分解器（对齐 MobiHop hub.rs:229-787）。
//
// 一个 socket 服务多个 peer：后台读循环按**源 SocketAddr** 把帧投进对应
// HubLink 的接收队列；新地址解析 32B 头 src → 建 HubLink 并上报 NodeId。
// Go 版最小集用单包收（批量 recvmmsg 是优化，阶段 2 可加）。
//
// ## 双栈（2026-11-19 对齐 MobiHop）
//
// `listen` 为未指定地址（`0.0.0.0` / `::` / 空）时默认绑 `[::]:port` 并显式关闭
// `IPV6_V6ONLY`，**一个 socket 同时收 IPv4 与 IPv6**：
//   - IPv4 报文在 v6 socket 上以 v4-mapped（`::ffff:a.b.c.d`）出现，收包边界统一
//     还原成普通 IPv4（`canonicalAddr`），否则同一个对端会因两种写法被当成两个地址；
//   - 出站时 v4 目的地在 v6 socket 上映射回 v4-mapped（`wireAddr`）。
//
// 这样 IPv6 侧可以免端口映射直连（运营商 CGNAT 下的唯一出路），IPv4 侧仍走原路径。

const hubQueueSize = 4096 // hub.rs:445

// UdpHub 管理单 socket 与多个 peer 的链路。
type UdpHub struct {
	conn      *net.UDPConn
	localAddr *net.UDPAddr
	// socketIsV6 表示底层 socket 是 AF_INET6（可能是双栈）；出站要按它映射地址。
	socketIsV6 bool

	mu      sync.RWMutex
	peers   map[string]*hubLink // canonical addr.String() -> HubLink（直连）
	byNode  map[NodeID]*hubLink // NodeID -> 该对端当前链路（中继转发分派用）
	relays  map[string]bool     // 已配置的中继地址（canonical string）
	closing bool
	wg      sync.WaitGroup

	// 新对端发现回调（NodeId + 地址），供上层 Router::add_link
	onIncoming func(NodeID, *net.UDPAddr)
	// UdpProbe 帧回调（0x08 不进普通队列，直接交探针跟踪器 —— 对齐 observe_probes）
	onProbe func([]byte)
	// 非 32B 帧的原始报文回调（STUN 响应用）。
	// STUN 与打洞必须复用**同一个 socket**，否则 NAT 映射不同、打洞端口对不上。
	onRaw func([]byte)
	// 控制帧的独立入站观察回调（HolePunch 0x05 / RelayMgmt 0x06）。
	//
	// 对齐 MobiHop hub.rs:386-393：demux 在**分流之前**把 (真实源地址, 帧副本)
	// 交给 observer，不管该地址有没有链路、活跃链路是不是 WSS。
	// CFPilot 曾把这些帧塞进活跃 link 的 recv 队列，切 WSS 后 UDP 打洞探测无人处理
	// （真机 txFrames 暴涨、rxFrames 不涨）—— CROSS_PROJECT_SYNC §11.5 指出这是移植 bug。
	onControl func(*net.UDPAddr, []byte)
}

// listenDualStack 在 [::]:port 上建一个 IPv4/IPv6 双栈 UDP socket。
//
// 必须在 bind **之前**设置 IPV6_V6ONLY=0：Go 的 net.ListenConfig.Control 正好在
// socket 创建后、bind 前被调用。
func listenDualStack(port int) (*net.UDPConn, error) {
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var sockErr error
			if err := c.Control(func(fd uintptr) {
				sockErr = setV6Only(fd, 0)
			}); err != nil {
				return err
			}
			return sockErr
		},
	}
	pc, err := lc.ListenPacket(context.Background(), "udp", net.JoinHostPort("::", fmt.Sprintf("%d", port)))
	if err != nil {
		return nil, err
	}
	conn, ok := pc.(*net.UDPConn)
	if !ok {
		_ = pc.Close()
		return nil, fmt.Errorf("mesh udp: 双栈监听返回非 UDPConn")
	}
	return conn, nil
}

// NewUdpHub 绑定 UDP socket 并启动 demux 循环（双栈默认开启）。
//
// bindAddr 是未指定地址（`0.0.0.0` / `::` / 空）时优先尝试 `[::]` 双栈绑定，
// 失败则回退到配置原地址（保证老环境仍能起来）；写具体 IP 时按该地址单族绑定。
func NewUdpHub(bindAddr string, onIncoming func(NodeID, *net.UDPAddr)) (*UdpHub, error) {
	return newUdpHub(bindAddr, true, onIncoming)
}

// NewUdpHubWithDual 显式指定是否允许双栈绑定（配置项 disableListenDual 用）。
func NewUdpHubWithDual(bindAddr string, dualStack bool, onIncoming func(NodeID, *net.UDPAddr)) (*UdpHub, error) {
	return newUdpHub(bindAddr, dualStack, onIncoming)
}

func newUdpHub(bindAddr string, dualStack bool, onIncoming func(NodeID, *net.UDPAddr)) (*UdpHub, error) {
	addr, err := net.ResolveUDPAddr("udp", bindAddr)
	if err != nil {
		return nil, fmt.Errorf("mesh udp: 解析地址失败: %w", err)
	}
	var conn *net.UDPConn
	unspecified := addr.IP == nil || addr.IP.IsUnspecified()
	if dualStack && unspecified {
		if c, derr := listenDualStack(addr.Port); derr == nil {
			conn = c
		}
	}
	if conn == nil {
		conn, err = net.ListenUDP("udp", addr)
		if err != nil {
			return nil, fmt.Errorf("mesh udp: 绑定 %s 失败: %w", bindAddr, err)
		}
	}
	local := conn.LocalAddr().(*net.UDPAddr)
	h := &UdpHub{
		conn:       conn,
		localAddr:  local,
		socketIsV6: local.IP.To4() == nil,
		peers:      make(map[string]*hubLink),
		byNode:     make(map[NodeID]*hubLink),
		relays:     make(map[string]bool),
		onIncoming: onIncoming,
	}
	h.wg.Add(1)
	go h.demuxLoop()
	return h, nil
}

// LocalAddr 返回实际绑定地址（双栈时为 `[::]:port`）。
func (h *UdpHub) LocalAddr() *net.UDPAddr { return h.localAddr }

// listenActual 返回给面板/日志看的实际监听地址。
//
// 配置写 `0.0.0.0:51820` 而实际绑了 `[::]:51820` 时，用户必须能看到真实值，
// 否则排查「IPv4 能通、IPv6 不通」时会被配置值误导。
func listenActual(configured string, hub *UdpHub) string {
	if hub != nil {
		if a := hub.LocalAddr(); a != nil {
			return a.String()
		}
	}
	return configured
}

// IsDualStack 报告底层 socket 是否为 AF_INET6（双栈）。
func (h *UdpHub) IsDualStack() bool { return h.socketIsV6 }

// canonicalAddr 把 v4-mapped 源地址还原为普通 IPv4。
//
// 关键：同一个对端在双栈 socket 上会以 `::ffff:1.2.3.4` 出现，
// 若不做归一，`map[string]` 里会有两份、打洞候选也会出现两种写法。
func canonicalAddr(a *net.UDPAddr) *net.UDPAddr {
	if a == nil {
		return nil
	}
	if v4 := a.IP.To4(); v4 != nil {
		return &net.UDPAddr{IP: v4, Port: a.Port}
	}
	return a
}

// wireAddr 把规范化后的地址映射成当前 socket 能直接发的地形式。
//
// v6 socket 发 IPv4 时显式换成 v4-mapped，不依赖 net 包对平台的隐式映射。
func (h *UdpHub) wireAddr(a *net.UDPAddr) *net.UDPAddr {
	if a == nil {
		return nil
	}
	if h.socketIsV6 && a.IP.To4() != nil {
		ip16 := make(net.IP, net.IPv6len)
		copy(ip16, []byte{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff})
		copy(ip16[12:], a.IP.To4())
		return &net.UDPAddr{IP: ip16, Port: a.Port}
	}
	return a
}

// AddRelayAddr 登记一台专用中继的地址。
//
// 中继转发来的帧**源地址是中继而不是对端**，必须按帧头 Src 分派给对端链路，
// 否则同一房间的多个对端会串台（都会落进同一个按地址建的队列）。
func (h *UdpHub) AddRelayAddr(addr *net.UDPAddr) {
	addr = canonicalAddr(addr)
	if addr == nil {
		return
	}
	h.mu.Lock()
	h.relays[addr.String()] = true
	h.mu.Unlock()
}

func (h *UdpHub) isRelayAddr(addr *net.UDPAddr) bool {
	addr = canonicalAddr(addr)
	if addr == nil {
		return false
	}
	h.mu.RLock()
	ok := h.relays[addr.String()]
	h.mu.RUnlock()
	return ok
}

// demuxLoop 读 socket，按源地址分解帧（hub.rs:304-470）。
func (h *UdpHub) demuxLoop() {
	defer h.wg.Done()
	buf := make([]byte, MaxFrame)
	for {
		n, remote, err := h.conn.ReadFromUDP(buf)
		if err != nil {
			h.mu.RLock()
			closing := h.closing
			h.mu.RUnlock()
			if closing {
				return
			}
			// ICMP Port Unreachable 会让 Windows 下次 recv 返回 WSAECONNRESET；
			// UDP socket 仍可用，瞬时错误继续（hub.rs:321-334）
			time.Sleep(10 * time.Millisecond)
			continue
		}
		frame := append([]byte(nil), buf[:n]...)
		h.dispatch(canonicalAddr(remote), frame)
	}
}

// SetProbeHandler 设置 UdpProbe 帧回调（0x08 直接交探针跟踪器，不进普通队列）。
func (h *UdpHub) SetProbeHandler(fn func([]byte)) {
	h.mu.Lock()
	h.onProbe = fn
	h.mu.Unlock()
}

// SetRawHandler 设置「非 MobiHop 帧」的原始报文回调（STUN 响应用）。
func (h *UdpHub) SetRawHandler(fn func([]byte)) {
	h.mu.Lock()
	h.onRaw = fn
	h.mu.Unlock()
}

// SetControlHandler 设置控制帧的独立入站观察回调（HolePunch / RelayMgmt）。
// 这些帧在 demux 分流之前、按真实源地址交给 observer，与活跃链路无关。
func (h *UdpHub) SetControlHandler(fn func(*net.UDPAddr, []byte)) {
	h.mu.Lock()
	h.onControl = fn
	h.mu.Unlock()
}

// dispatch 把帧按源地址投进对应队列；新地址则建链路并上报。
func (h *UdpHub) dispatch(remote *net.UDPAddr, frame []byte) {
	// 不是 MobiHop 帧（首字节不是 magic）⇒ 交给原始回调（STUN 等）。
	if len(frame) < 3 || frame[0] != MagicByte {
		h.mu.RLock()
		raw := h.onRaw
		h.mu.RUnlock()
		if raw != nil {
			raw(frame)
		}
		return
	}
	// 控制帧（HolePunch 0x05 / RelayMgmt 0x06）：**分流之前**无条件交观察通道，
	// 与「该地址有没有链路、活跃链路是不是 WSS」无关（MobiHop hub.rs:386-393）。
	// 这样切 WSS 后，来自 UDP 候选地址的打洞探测/中继应答仍能被处理。
	if len(frame) >= 3 && frame[0] == MagicByte &&
		(frame[2] == byte(MsgHolePunch) || frame[2] == byte(MsgRelayMgmt)) {
		h.mu.RLock()
		ctrl := h.onControl
		h.mu.RUnlock()
		if ctrl != nil {
			ctrl(remote, frame)
		}
	}
	// 0x08 UdpProbe 直接交探针跟踪器（对齐 UdpHub.observe_probes），不进 peer 队列，
	// 这样降级后 active link 为 WSS 时 UDP 探针仍能被接收。
	if len(frame) >= 3 && frame[0] == MagicByte && frame[2] == byte(MsgUdpProbe) {
		h.mu.RLock()
		fn := h.onProbe
		h.mu.RUnlock()
		if fn != nil {
			fn(frame)
			return
		}
	}
	// 中继转发来的帧：源地址是中继，必须按帧头 Src 找对端链路。
	if h.isRelayAddr(remote) {
		parsed, err := Decode(frame)
		if err != nil {
			return
		}
		h.mu.Lock()
		link := h.byNode[parsed.Src]
		if link == nil {
			// 还没收到过该对端的直连帧：先建一条中继腿，保证首帧（握手）不丢。
			link = &hubLink{
				hub:     h,
				addr:    remote,
				rx:      make(chan []byte, hubQueueSize),
				nodeID:  parsed.Src,
				relayed: true,
			}
			h.byNode[parsed.Src] = link
		}
		h.mu.Unlock()
		select {
		case link.rx <- frame:
		default:
		}
		return
	}
	key := remote.String()
	h.mu.RLock()
	link, exists := h.peers[key]
	h.mu.RUnlock()

	if exists {
		select {
		case link.rx <- frame:
		default:
			// 队列满：丢弃（不阻塞 demux 循环，hub.rs:405-428 同理）
		}
		return
	}

	// 新对端：从帧头解析 NodeId（hub.rs:432）
	if len(frame) < HeaderLen {
		return
	}
	parsed, err := Decode(frame)
	if err != nil {
		return
	}
	h.mu.Lock()
	// 双重检查（并发首包）
	link, exists = h.peers[key]
	if !exists {
		link = &hubLink{
			hub:    h,
			addr:   remote,
			rx:     make(chan []byte, hubQueueSize),
			nodeID: parsed.Src,
		}
		h.peers[key] = link
	}
	// 直连帧证明该对端在此地址可达：按 NodeID 记为它的当前链路。
	h.byNode[parsed.Src] = link
	h.mu.Unlock()

	if !exists && h.onIncoming != nil {
		h.onIncoming(parsed.Src, remote)
	}
	select {
	case link.rx <- frame:
	default:
	}
}

// LinkTo 返回到指定地址的 PeerLink（不存在则创建，hub.rs:753）。
func (h *UdpHub) LinkTo(addr *net.UDPAddr) PeerLink {
	addr = canonicalAddr(addr)
	key := addr.String()
	h.mu.Lock()
	defer h.mu.Unlock()
	if link, ok := h.peers[key]; ok {
		return link
	}
	link := &hubLink{
		hub:  h,
		addr: addr,
		rx:   make(chan []byte, hubQueueSize),
	}
	h.peers[key] = link
	return link
}

// RelayLinkTo 返回到「经中继转发」的伪链路。
//
// 它把帧发给中继地址，由中继按帧头 Dst 转发给对端；`IsRelayed()` 为 true，
// 因此打洞升级、状态显示、探针目标都能识别出这条腿不是直连。
func (h *UdpHub) RelayLinkTo(relayAddr *net.UDPAddr, peer NodeID) PeerLink {
	relayAddr = canonicalAddr(relayAddr)
	h.mu.Lock()
	defer h.mu.Unlock()
	if l, ok := h.byNode[peer]; ok && l.relayed && relayAddr != nil && l.addr.String() == relayAddr.String() {
		return l
	}
	link := &hubLink{
		hub:     h,
		addr:    relayAddr,
		rx:      make(chan []byte, hubQueueSize),
		nodeID:  peer,
		relayed: true,
	}
	h.byNode[peer] = link
	return link
}

// Forget 移除地址条目（hub.rs:602）。
func (h *UdpHub) Forget(addr *net.UDPAddr) {
	if addr == nil {
		return
	}
	key := canonicalAddr(addr).String()
	h.mu.Lock()
	if l, ok := h.peers[key]; ok {
		delete(h.peers, key)
		if h.byNode[l.nodeID] == l {
			delete(h.byNode, l.nodeID)
		}
	}
	h.mu.Unlock()
}

// SendProbeTo 复用同一 socket 向任意地址发探测帧（hub.rs:580，打洞用）。
func (h *UdpHub) SendProbeTo(ctx context.Context, addr *net.UDPAddr, frame []byte) error {
	_, err := h.conn.WriteToUDP(frame, h.wireAddr(canonicalAddr(addr)))
	return err
}

// Close 关闭 socket 并等待 demux 退出。
func (h *UdpHub) Close() error {
	h.mu.Lock()
	h.closing = true
	h.mu.Unlock()
	err := h.conn.Close()
	h.wg.Wait()
	return err
}

// hubLink 是 UdpHub 中到单个地址的 PeerLink（hub.rs:818-934）。
type hubLink struct {
	baseLink
	hub     *UdpHub
	addr    *net.UDPAddr
	rx      chan []byte
	nodeID  NodeID
	relayed bool
}

// IsRelayed 报告这条腿是否经中继（伪链路）。
func (l *hubLink) IsRelayed() bool { return l.relayed }

func (l *hubLink) Send(ctx context.Context, frame []byte) error {
	_, err := l.hub.conn.WriteToUDP(frame, l.hub.wireAddr(l.addr))
	return err
}

func (l *hubLink) SendProbe(ctx context.Context, frame []byte) error {
	return l.Send(ctx, frame)
}

func (l *hubLink) Recv(ctx context.Context) ([]byte, error) {
	select {
	case frame := <-l.rx:
		return frame, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// PeerAddr 返回对端传输层地址；中继腿没有真实对端地址，返回 nil
// （探针与面板都不该把它当成直连地址）。
func (l *hubLink) PeerAddr() *net.UDPAddr {
	if l.relayed {
		return nil
	}
	return l.addr
}

func (l *hubLink) Close() error {
	if l.relayed {
		l.hub.mu.Lock()
		if l.hub.byNode[l.nodeID] == l {
			delete(l.hub.byNode, l.nodeID)
		}
		l.hub.mu.Unlock()
		return nil
	}
	// 单 socket 多路分解：单条链路关闭只从 hub 移除地址条目，不关共享 socket。
	l.hub.Forget(l.addr)
	return nil
}
