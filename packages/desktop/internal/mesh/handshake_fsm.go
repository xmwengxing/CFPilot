package mesh

import (
	"fmt"
	"sync"
	"time"

	"github.com/flynn/noise"
)

// 握手 FSM（Phase 3b-2c 阶段 1b，对齐 MobiHop dataplane/session.rs:551-1041）。
//
// 真实流程是**被动触发 + 三帧经链路交换**：
//  1. 发起方（小 NodeId）首个出站包 → start_initiator → 发 msg1（-> e, es, s, ss）
//  2. 响应方收 msg1 → 发 msg2（<- e, ee, se, psk）→ 等 KeyMaterial
//  3. 发起方收 msg2 → 握手完成 → InitiatorKeyMaterial 生成 data_key+session+wire → 发 wire
//  4. 响应方收 wire → ResponderFromKeyMaterial 建立 session
//
// 三帧都经 sendFn（由 router/link 注入）发送，与具体传输（UDP/WSS）解耦。
// Session 按 NodeId 安装，与链路无关（降级只换链路不重建会话）。

// HandshakeState 是握手状态。
type HandshakeState int

const (
	HSIdle            HandshakeState = iota // 无握手
	HSWaitMsg2                              // 发起方：已发 msg1，等 msg2
	HSWaitKeyMaterial                       // 响应方：已发 msg2，等 KeyMaterial
	HSEstablished                           // 会话已建立
)

func (s HandshakeState) String() string {
	switch s {
	case HSIdle:
		return "idle"
	case HSWaitMsg2:
		return "wait-msg2"
	case HSWaitKeyMaterial:
		return "wait-key-material"
	case HSEstablished:
		return "established"
	default:
		return "unknown"
	}
}

// pending 是进行中的握手（对齐 Pending 枚举，session.rs:556-572）。
type pending struct {
	state    HandshakeState
	hs       *Handshake // flynn/noise 状态机（握手完成后其 CipherState 用于 KeyMaterial）
	started  time.Time
	attempts int
}

// peerSession 是已建立的会话（对齐 PeerSession：current + draining，session.rs:551-554）。
type peerSession struct {
	current  *Session
	draining []*Session
}

// HandshakeFSM 管理到多个对端的握手与会话。
type HandshakeFSM struct {
	mu       sync.Mutex
	selfID   NodeID
	network  [32]byte
	psk      [32]byte
	static   noise.DHKey
	pending  map[NodeID]*pending
	sessions map[NodeID]*peerSession

	sendFn        func(dst NodeID, frame []byte) error
	onEstablished func(peer NodeID, sess *Session)
}

func NewHandshakeFSM(selfID NodeID, network, psk [32]byte, static noise.DHKey) *HandshakeFSM {
	return &HandshakeFSM{
		selfID:   selfID,
		network:  network,
		psk:      psk,
		static:   static,
		pending:  make(map[NodeID]*pending),
		sessions: make(map[NodeID]*peerSession),
	}
}

func (f *HandshakeFSM) SetSendFn(fn func(NodeID, []byte) error)    { f.sendFn = fn }
func (f *HandshakeFSM) SetOnEstablished(fn func(NodeID, *Session)) { f.onEstablished = fn }

// IsInitiator 破对称：小 NodeId 保留发起方（session.rs:927）。
func (f *HandshakeFSM) IsInitiator(peer NodeID) bool { return lessNodeID(f.selfID, peer) }

// EncodeHandshakeFrame 封装 0x01 Handshake 帧（不置 ENCRYPTED，control.rs:41-43）。
func EncodeHandshakeFrame(src, dst NodeID, msg []byte) ([]byte, error) {
	return (&Frame{
		Type: MsgHandshake, Flags: 0, TTL: DefaultTTL,
		Payload: msg, Src: src, Dst: dst, Counter: 0,
	}).Encode()
}

// StartOutbound 首个出站包触发握手（session.rs:679-703）。
func (f *HandshakeFSM) StartOutbound(peer NodeID, peerStatic []byte) error {
	f.mu.Lock()
	if _, ok := f.sessions[peer]; ok {
		f.mu.Unlock()
		return nil
	}
	if _, ok := f.pending[peer]; ok {
		f.mu.Unlock()
		return nil
	}
	if !f.IsInitiator(peer) {
		f.mu.Unlock()
		return nil // 非发起方：等对端 Init
	}
	hs, err := NewInitiatorHandshake(f.psk, f.network[:], f.static, noise.DHKey{Public: peerStatic})
	if err != nil {
		f.mu.Unlock()
		return fmt.Errorf("handshake fsm: 构造发起方失败: %w", err)
	}
	f.pending[peer] = &pending{state: HSWaitMsg2, hs: hs, started: time.Now(), attempts: 1}
	f.mu.Unlock()

	msg1, err := hs.WriteMessage(nil)
	if err != nil {
		return fmt.Errorf("handshake fsm: 生成 msg1 失败: %w", err)
	}
	frame, err := EncodeHandshakeFrame(f.selfID, peer, msg1)
	if err != nil {
		return err
	}
	if f.sendFn == nil {
		return fmt.Errorf("handshake fsm: sendFn 未设置")
	}
	return f.sendFn(peer, frame)
}

// OnFrame 处理入站 Handshake 帧。返回 (consumed, error)。
// 按 pending 状态明确分派，不用长度启发式：
//   - 无 pending → msg1（作为响应方）
//   - HSWaitMsg2 → msg2（发起方完成握手，随后发 KeyMaterial）
//   - HSWaitKeyMaterial → KeyMaterial 帧（响应方建会话）
func (f *HandshakeFSM) OnFrame(frame []byte) (bool, error) {
	parsed, err := Decode(frame)
	if err != nil {
		return false, err
	}
	if parsed.Type != MsgHandshake {
		return false, nil
	}

	f.mu.Lock()
	p, hasPending := f.pending[parsed.Src]
	f.mu.Unlock()

	if !hasPending {
		return true, f.onInit(parsed)
	}
	switch p.state {
	case HSWaitMsg2:
		return true, f.onMsg2(parsed, p)
	case HSWaitKeyMaterial:
		return true, f.onKeyMaterial(parsed, p)
	default:
		return true, fmt.Errorf("handshake fsm: 来自 %x 的握手帧状态异常 %s", parsed.Src[:4], p.state)
	}
}

// onInit 响应方收 msg1 → 发 msg2 → 等 KeyMaterial（session.rs:925-958）。
func (f *HandshakeFSM) onInit(parsed *Frame) error {
	// 破对称：若本端已作为发起方处理同一对端（极小概率），小 NodeId 让位
	if f.IsInitiator(parsed.Src) {
		// 本端更小，应保留发起方角色，忽略对端 Init
		return nil
	}
	hs, err := NewResponderHandshake(f.psk, f.network[:], f.static)
	if err != nil {
		return fmt.Errorf("handshake fsm: 构造响应方失败: %w", err)
	}
	if _, err := hs.ReadMessage(parsed.Payload); err != nil {
		return fmt.Errorf("handshake fsm: 读 msg1 失败: %w", err)
	}
	f.mu.Lock()
	f.pending[parsed.Src] = &pending{state: HSWaitKeyMaterial, hs: hs, started: time.Now()}
	f.mu.Unlock()
	msg2, err := hs.WriteMessage(nil)
	if err != nil {
		return fmt.Errorf("handshake fsm: 生成 msg2 失败: %w", err)
	}
	return f.sendFrame(parsed.Src, msg2)
}

// onMsg2 发起方收 msg2 → 完成握手 → 生成 KeyMaterial 并发送（session.rs:970-1002）。
func (f *HandshakeFSM) onMsg2(parsed *Frame, p *pending) error {
	payload, err := p.hs.Complete(parsed.Payload)
	if err != nil {
		return fmt.Errorf("handshake fsm: 读 msg2 失败: %w", err)
	}
	_ = payload // 响应方 payload 通常为空
	// 生成 data_key + 本端 session + KeyMaterial wire
	wire, sess, err := InitiatorKeyMaterial(p.hs.SendState())
	if err != nil {
		return fmt.Errorf("handshake fsm: 生成 KeyMaterial 失败: %w", err)
	}
	f.mu.Lock()
	f.installSessionLocked(parsed.Src, sess)
	f.mu.Unlock()
	return f.sendFrame(parsed.Src, wire)
}

// onKeyMaterial 响应方收 KeyMaterial → 建立 session（session.rs:1005-1041）。
func (f *HandshakeFSM) onKeyMaterial(parsed *Frame, p *pending) error {
	sess, err := ResponderFromKeyMaterial(p.hs.RecvState(), parsed.Payload)
	if err != nil {
		return fmt.Errorf("handshake fsm: 恢复 KeyMaterial 失败: %w", err)
	}
	f.mu.Lock()
	f.installSessionLocked(parsed.Src, sess)
	f.mu.Unlock()
	return nil
}

func (f *HandshakeFSM) sendFrame(dst NodeID, msg []byte) error {
	frame, err := EncodeHandshakeFrame(f.selfID, dst, msg)
	if err != nil {
		return err
	}
	if f.sendFn == nil {
		return fmt.Errorf("handshake fsm: sendFn 未设置")
	}
	return f.sendFn(dst, frame)
}

func (f *HandshakeFSM) installSessionLocked(peer NodeID, sess *Session) {
	f.sessions[peer] = &peerSession{current: sess}
	delete(f.pending, peer)
	if f.onEstablished != nil {
		f.onEstablished(peer, sess)
	}
}

// Session 返回到对端的已建立会话。
func (f *HandshakeFSM) Session(peer NodeID) (*Session, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ps, ok := f.sessions[peer]
	if !ok {
		return nil, false
	}
	return ps.current, true
}

// State 返回到对端的握手状态（诊断用）。
func (f *HandshakeFSM) State(peer NodeID) HandshakeState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ps, ok := f.sessions[peer]; ok && ps.current != nil {
		return HSEstablished
	}
	if p, ok := f.pending[peer]; ok {
		return p.state
	}
	return HSIdle
}

func lessNodeID(a, b NodeID) bool {
	for i := 0; i < 8; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}
