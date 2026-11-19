package mesh

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"
)

// UdpHub 是单 UDP socket 多路分解器（对齐 MobiHop hub.rs:229-787）。
//
// 一个 socket 服务多个 peer：后台读循环按**源 SocketAddr** 把帧投进对应
// HubLink 的接收队列；新地址解析 32B 头 src → 建 HubLink 并上报 NodeId。
// Go 版最小集用单包收（批量 recvmmsg 是优化，阶段 2 可加）。

const hubQueueSize = 4096 // hub.rs:445

// UdpHub 管理单 socket 与多个 peer 的链路。
type UdpHub struct {
	conn      *net.UDPConn
	localAddr *net.UDPAddr

	mu      sync.RWMutex
	peers   map[string]*hubLink // addr.String() -> HubLink
	closing bool
	wg      sync.WaitGroup

	// 新对端发现回调（NodeId + 地址），供上层 Router::add_link
	onIncoming func(NodeID, *net.UDPAddr)
	// UdpProbe 帧回调（0x08 不进普通队列，直接交探针跟踪器 —— 对齐 observe_probes）
	onProbe func([]byte)
	// 非 32B 帧的原始报文回调（STUN 响应用）。
	// STUN 与打洞必须复用**同一个 socket**，否则 NAT 映射不同、打洞端口对不上。
	onRaw func([]byte)
}

// NewUdpHub 绑定 UDP socket 并启动 demux 循环。
func NewUdpHub(bindAddr string, onIncoming func(NodeID, *net.UDPAddr)) (*UdpHub, error) {
	addr, err := net.ResolveUDPAddr("udp", bindAddr)
	if err != nil {
		return nil, fmt.Errorf("mesh udp: 解析地址失败: %w", err)
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("mesh udp: 绑定 %s 失败: %w", bindAddr, err)
	}
	h := &UdpHub{
		conn:       conn,
		localAddr:  conn.LocalAddr().(*net.UDPAddr),
		peers:      make(map[string]*hubLink),
		onIncoming: onIncoming,
	}
	h.wg.Add(1)
	go h.demuxLoop()
	return h, nil
}

// LocalAddr 返回实际绑定地址。
func (h *UdpHub) LocalAddr() *net.UDPAddr { return h.localAddr }

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
		h.dispatch(remote, frame)
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
			baseLink: baseLink{},
			hub:      h,
			addr:     remote,
			rx:       make(chan []byte, hubQueueSize),
			nodeID:   parsed.Src,
		}
		h.peers[key] = link
	}
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
	key := addr.String()
	h.mu.Lock()
	defer h.mu.Unlock()
	if link, ok := h.peers[key]; ok {
		return link
	}
	link := &hubLink{
		baseLink: baseLink{},
		hub:      h,
		addr:     addr,
		rx:       make(chan []byte, hubQueueSize),
	}
	h.peers[key] = link
	return link
}

// Forget 移除地址条目（hub.rs:602）。
func (h *UdpHub) Forget(addr *net.UDPAddr) {
	if addr == nil {
		return
	}
	h.mu.Lock()
	delete(h.peers, addr.String())
	h.mu.Unlock()
}

// SendProbeTo 复用同一 socket 向任意地址发探测帧（hub.rs:580，打洞用）。
func (h *UdpHub) SendProbeTo(ctx context.Context, addr *net.UDPAddr, frame []byte) error {
	_, err := h.conn.WriteToUDP(frame, addr)
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
	hub    *UdpHub
	addr   *net.UDPAddr
	rx     chan []byte
	nodeID NodeID
}

func (l *hubLink) Send(ctx context.Context, frame []byte) error {
	_, err := l.hub.conn.WriteToUDP(frame, l.addr)
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

func (l *hubLink) PeerAddr() *net.UDPAddr { return l.addr }

func (l *hubLink) Close() error {
	// 单 socket 多路分解：单条链路关闭只从 hub 移除地址条目，不关共享 socket。
	l.hub.Forget(l.addr)
	return nil
}

