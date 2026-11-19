package mesh

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/vmihailenco/msgpack/v5"
)

// UdpProbe（0x08）链路测量（契约 §6.4，对齐 control.rs:24-36 + router.rs:1320-1342）。
//
// WSS 降级期，每 1s 经已绑定 UDP socket 向对端 UDP 地址发 UdpProbe(Ping)，
// 对端原路回 UdpProbe(Pong)。收集 RTT/丢包，作为回切判据数据源。
// 0x08 不 e2e 路由（header.rs:64），中继收到即丢弃——它只在直连 UDP 上做健康探测。
//
// ## 时钟口径（H0-2，必须与 MobiHop 一致）
//
// `Ping.timestamp_ms` = **本机进程内单调毫秒**（进程启动为 0），
// `Pong.timestamp_ms` = 原样回显 Ping 的值（不做任何时钟换算、不在回显侧重算），
// RTT 只在**发送侧**算：`monotonic_now - echoed_timestamp_ms`。
//
// ⚠️ 用墙钟（UnixMilli）也能跑，但系统校时会让 RTT 出现负值/跳变；
// 更危险的是「在回显侧用接收时刻回填」——那会把 RTT 算成 ≈0。
var meshMonotonicStart = time.Now()

// MonotonicMS 返回进程内单调毫秒（启动为 0）。
func MonotonicMS() uint64 { return uint64(time.Since(meshMonotonicStart).Milliseconds()) }

// PingMsg / PongMsg 是 named MessagePack（control.rs:24-36）。
type PingMsg struct {
	TimestampMS uint64 `msgpack:"timestamp_ms"`
	Nonce       uint64 `msgpack:"nonce"`
}

type PongMsg struct {
	TimestampMS uint64 `msgpack:"timestamp_ms"`
	Nonce       uint64 `msgpack:"nonce"`
}

func EncodePing(p *PingMsg) ([]byte, error) { return msgpack.Marshal(p) }
func DecodePong(b []byte) (*PongMsg, error) {
	var p PongMsg
	if err := msgpack.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("mesh probe: 解码 Pong 失败: %w", err)
	}
	return &p, nil
}

// ProbeTracker 管理每个 peer 的 UDP 探针收发计数与 RTT（router.rs:246-261）。
type ProbeTracker struct {
	mu     sync.Mutex
	peers  map[NodeID]*peerProbe
	hub    *UdpHub
	selfID NodeID
	// wireVersion 返回发给某对端的线速版本（nil 时用默认 v2）。
	// 由生命周期注入，保证 v1 对端能收到探针。
	wireVersion func(NodeID) byte
}

type peerProbe struct {
	addr      *net.UDPAddr
	sentTotal uint64
	pongTotal uint64
	lastRTTMS   uint32
	lastNonce   uint64
	lastPongAt  time.Time // 最近一次收到 Pong 的时刻（会话活性/离线判定）
	// 探针结果（与发送一一对应）：下标=发送序号，值=是否收到应答。
	// SendProbe append(false)，收到 Pong 时按 nonce 找到位置改 true。
	probeNonces  []uint64
	probeResults []bool
}

func NewProbeTracker(hub *UdpHub, selfID NodeID) *ProbeTracker {
	return &ProbeTracker{
		peers:  make(map[NodeID]*peerProbe),
		hub:    hub,
		selfID: selfID,
	}
}

// SetWireVersionProvider 注入「对端线速版本」查询函数。
func (t *ProbeTracker) SetWireVersionProvider(fn func(NodeID) byte) {
	t.mu.Lock()
	t.wireVersion = fn
	t.mu.Unlock()
}

// versionFor 返回发给该对端的版本（未注入或未知时用默认 v2）。
func (t *ProbeTracker) versionFor(id NodeID) byte {
	if t.wireVersion == nil {
		return WireVersionDefault
	}
	if v := t.wireVersion(id); v == WireVersionV1 || v == WireVersionV2 {
		return v
	}
	return WireVersionDefault
}

// SetPeer 设置对端 UDP 地址（降级后仍需知道对端地址才能发探针）。
func (t *ProbeTracker) SetPeer(id NodeID, addr *net.UDPAddr) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := t.peers[id]
	if p == nil {
		p = &peerProbe{}
		t.peers[id] = p
	}
	p.addr = addr
}

// SendProbe 发一个 UdpProbe(Ping) 帧，返回 nonce（供应答匹配）。
func (t *ProbeTracker) SendProbe(ctx context.Context, id NodeID) (uint64, error) {
	t.mu.Lock()
	p := t.peers[id]
	if p == nil || p.addr == nil {
		t.mu.Unlock()
		return 0, fmt.Errorf("mesh probe: peer %x 无 UDP 地址", id[:4])
	}
	nonce := uint64(time.Now().UnixNano())
	p.lastNonce = nonce
	p.sentTotal++
	// 记一个待应答探针（窗口封顶 lossWindowTicks）
	p.probeNonces = append(p.probeNonces, nonce)
	p.probeResults = append(p.probeResults, false)
	if len(p.probeNonces) > lossWindowTicks {
		p.probeNonces = p.probeNonces[1:]
		p.probeResults = p.probeResults[1:]
	}
	t.mu.Unlock()

	ping := &PingMsg{TimestampMS: MonotonicMS(), Nonce: nonce}
	payload, err := EncodePing(ping)
	if err != nil {
		return 0, err
	}
	// Ping 带 ACK_REQ 标志；Pong 不带（对齐 MobiHop：用 flags 区分请求/应答）
	frame, err := (&Frame{
		Version: t.versionFor(id),
		Type:    MsgUdpProbe, Flags: FlagAckReq, TTL: DefaultTTL,
		Payload: payload, Src: t.selfID, Dst: id, Counter: nonce,
	}).Encode()
	if err != nil {
		return 0, err
	}
	if err := t.hub.SendProbeTo(ctx, p.addr, frame); err != nil {
		return 0, err
	}
	return nonce, nil
}

// OnProbeFrame 处理收到的 UdpProbe 帧（Ping→回 Pong / Pong→计 RTT）。
// 返回 (是否消费, error)。
func (t *ProbeTracker) OnProbeFrame(ctx context.Context, frameBytes []byte) (bool, error) {
	f, err := Decode(frameBytes)
	if err != nil || f.Type != MsgUdpProbe {
		return false, err
	}
	if len(f.Payload) == 0 {
		return true, nil
	}
	// 用 ACK_REQ flag 区分：带 = Ping（请求，回 Pong）；不带 = Pong（应答，计 RTT）。
	// 对齐 MobiHop router.rs:1120-1145（Ping 带 ACK_REQ，Pong 不带）。
	isPing := f.Flags&FlagAckReq != 0
	msg, err := DecodePong(f.Payload)
	if err != nil {
		return true, err
	}
	if !isPing {
		// Pong：按 nonce 找到对应探针位置标记 answered → 计 RTT
		t.mu.Lock()
		for _, p := range t.peers {
			for i, n := range p.probeNonces {
				if n == msg.Nonce && msg.Nonce != 0 {
					p.probeResults[i] = true
					p.pongTotal++
					p.lastPongAt = time.Now()
					// RTT 只在发送侧算：单调当前 - 对端原样回显的单调值。
					// 用有符号判断，避免校时/时钟重置后下溢成巨大值。
					if now := MonotonicMS(); now >= msg.TimestampMS {
						rtt := now - msg.TimestampMS
						if rtt < 1<<32 {
							p.lastRTTMS = uint32(rtt)
						}
					}
					t.mu.Unlock()
					return true, nil
				}
			}
		}
		t.mu.Unlock()
		return true, nil // 不匹配的 Pong 忽略
	}
	// Ping：回 Pong（不带 ACK_REQ）
	ping := msg
	resp := &PongMsg{TimestampMS: ping.TimestampMS, Nonce: ping.Nonce}
	payload, _ := msgpack.Marshal(resp)
	reply, err := (&Frame{
		Version: t.versionFor(f.Src),
		Type:    MsgUdpProbe, Flags: 0, TTL: DefaultTTL,
		Payload: payload, Src: t.selfID, Dst: f.Src, Counter: f.Counter,
	}).Encode()
	if err != nil {
		return true, err
	}
	if t.hub != nil {
		// 原路回显：用对端源地址（需从 demux 拿到；此处简化为经 hub 已知 peer）
		t.mu.Lock()
		p := t.peers[f.Src]
		t.mu.Unlock()
		if p != nil && p.addr != nil {
			_ = t.hub.SendProbeTo(ctx, p.addr, reply)
		}
	}
	return true, nil
}

// Measurement 返回某 peer 的 (loss, samples, rtt_ms)（供 DegradePolicy.observe）。
// 直接基于 probeResults（每个已发探针是否有对应 Pong）计算，与探针一一对应，
// 避免累计值/采样时机导致的误判（真机暴露的 bug）。
func (t *ProbeTracker) Measurement(id NodeID) (loss float64, samples uint32, rttMS uint32) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := t.peers[id]
	if p == nil || len(p.probeResults) == 0 {
		return 0, 0, 0
	}
	n := len(p.probeResults)
	// 样本不足时按 0.0 上报（不误报）—— 对齐 router.rs:49 的 LOSS_MIN_SAMPLES。
	// 判「链路坏」需要连续坏窗口，不能让 1~4 个样本就把对端判死。
	if n < LossMinSamples {
		return 0, uint32(n), p.lastRTTMS
	}
	got := 0
	for _, r := range p.probeResults {
		if r {
			got++
		}
	}
	return 1.0 - float64(got)/float64(n), uint32(n), p.lastRTTMS
}

// RecordSample 保留（200ms tick 调用），结果已在 probeResults 中实时维护，
// 此处无需额外动作；保留空实现避免调用方改动。
func (t *ProbeTracker) RecordSample(id NodeID) {}

// LastPongAge 返回距最近一次 Pong 的时间；从未收到返回极大值。
//
// 用途：状态面板判定「会话还在、但对端已无响应」（例如对端停止组网）。
func (t *ProbeTracker) LastPongAge(id NodeID) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := t.peers[id]
	if p == nil || p.lastPongAt.IsZero() {
		return 1 << 62
	}
	return time.Since(p.lastPongAt)
}

// Counters 返回 (sent, pong, rtt)（诊断用）。
func (t *ProbeTracker) Counters(id NodeID) (sent, pong uint64, rtt uint32) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if p := t.peers[id]; p != nil {
		return p.sentTotal, p.pongTotal, p.lastRTTMS
	}
	return 0, 0, 0
}

