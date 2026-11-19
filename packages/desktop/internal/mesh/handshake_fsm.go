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
	// lastMsg 是最近一次发出去的握手载荷（不含 32B 头）。
	// ADR-0016 的降级兜底要「用 v1 重发 Init」，重发的必须是与首次**同一份** Noise 字节。
	lastMsg []byte
	// sentAt 是 lastMsg 的发送时刻（重试节流用）。
	sentAt time.Time
	// downgraded 表示已经因「从未收到该对端帧」把版本降到 v1（只降一次）。
	downgraded bool
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

	// wireVersions 与生命周期共享：控制帧按对端版本编码，学到 v1 后立刻降级。
	wireVersions *PeerWireVersions
	// now 可注入（测试用）；nil 时用 time.Now。
	now func() time.Time

	sendFn        func(dst NodeID, frame []byte) error
	onEstablished func(peer NodeID, sess *Session)
}

func NewHandshakeFSM(selfID NodeID, network, psk [32]byte, static noise.DHKey) *HandshakeFSM {
	return &HandshakeFSM{
		selfID:       selfID,
		network:      network,
		psk:          psk,
		static:       static,
		pending:      make(map[NodeID]*pending),
		sessions:     make(map[NodeID]*peerSession),
		wireVersions: NewPeerWireVersions(),
	}
}

// WireVersions 返回共享的对端版本登记表（生命周期用它做学习与编码）。
func (f *HandshakeFSM) WireVersions() *PeerWireVersions { return f.wireVersions }

// SetWireVersions 注入共享登记表（到一个进程只有一份的语义）。
func (f *HandshakeFSM) SetWireVersions(v *PeerWireVersions) {
	if v != nil {
		f.wireVersions = v
	}
}

// SetClock 注入时钟（测试用）。
func (f *HandshakeFSM) SetClock(now func() time.Time) { f.now = now }

func (f *HandshakeFSM) clock() time.Time {
	if f.now != nil {
		return f.now()
	}
	return time.Now()
}

func (f *HandshakeFSM) SetSendFn(fn func(NodeID, []byte) error)    { f.sendFn = fn }
func (f *HandshakeFSM) SetOnEstablished(fn func(NodeID, *Session)) { f.onEstablished = fn }

// IsInitiator 破对称：小 NodeId 保留发起方（session.rs:927）。
func (f *HandshakeFSM) IsInitiator(peer NodeID) bool { return lessNodeID(f.selfID, peer) }

// EncodeHandshakeFrame 封装 0x01 Handshake 帧（不置 ENCRYPTED，control.rs:41-43）。
//
// wireVersion 省略时按默认（v2）；对已知 v1 对端必须传 WireVersionV1 ——
// 否则旧节点在头部版本校验处直接丢帧，握手永远建立不起来。
func EncodeHandshakeFrame(src, dst NodeID, msg []byte, wireVersion ...byte) ([]byte, error) {
	v := WireVersionDefault
	if len(wireVersion) > 0 && wireVersion[0] != 0 {
		v = wireVersion[0]
	}
	return (&Frame{
		Version: v, Type: MsgHandshake, Flags: 0, TTL: DefaultTTL,
		Payload: msg, Src: src, Dst: dst, Counter: 0,
	}).Encode()
}

// StartOutbound 首个出站包触发握手（session.rs:679-703）。
func (f *HandshakeFSM) StartOutbound(peer NodeID, peerStatic []byte) error {
	return f.startOutbound(peer, peerStatic, false)
}

// StartOutboundForce 忽略「只有小 NodeId 才发起」的破对称规则，强制发起握手。
//
// 用途：一端重启后会话失效，但**发起方是另一端**且它仍持有旧会话，不会主动重来。
// 此时由需要发数据的一方强制发 Init；对端若已有旧会话，会在 KeyMaterial 到达时
// 用新会话替换（旧会话在新会话装好前保持可用，避免被伪造 Init 直接打掉）。
func (f *HandshakeFSM) StartOutboundForce(peer NodeID, peerStatic []byte) error {
	return f.startOutbound(peer, peerStatic, true)
}

func (f *HandshakeFSM) startOutbound(peer NodeID, peerStatic []byte, force bool) error {
	f.mu.Lock()
	if _, ok := f.sessions[peer]; ok {
		f.mu.Unlock()
		return nil
	}
	if _, ok := f.pending[peer]; ok {
		f.mu.Unlock()
		return nil
	}
	if !force && !f.IsInitiator(peer) {
		f.mu.Unlock()
		return nil // 非发起方：等对端 Init（除非调用方要求强制重建）
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
	version := f.wireVersions.VersionFor(peer)
	frame, err := EncodeHandshakeFrame(f.selfID, peer, msg1, version)
	if err != nil {
		return err
	}
	// 记录载荷与时刻：ADR-0016 的 5s 降级兜底要用**同一份** msg1 以 v1 重发。
	f.mu.Lock()
	if p, ok := f.pending[peer]; ok {
		p.lastMsg = append([]byte(nil), msg1...)
		p.sentAt = f.clock()
	}
	f.mu.Unlock()
	if f.sendFn == nil {
		return fmt.Errorf("handshake fsm: sendFn 未设置")
	}
	return f.sendFn(peer, frame)
}

// RetryPending 处理「发出 Init 后一直没收到该对端任何帧」的降级兜底。
//
// 对齐 ADR-0016 / session.rs:1452：首次重试（5 s）时若从未收到过该对端任何帧，
// 就把该对端置 LEGACY_VERSION 并**用同一份 Init 载荷**重发。
// v2 对端也接受 0x01，所以降级是安全的；学到 v1 后该对端的所有帧都按 v1 发。
//
// 返回本次真正重发的 peer 数（诊断/测试用）。
// RetryPending 维护发起方的 Init：**周期性重发**，并在「从未收到该对端任何帧」时
// 降级到 v1 重发（ADR-0016 / session.rs:1452）。
//
// 为什么必须周期重发：UDP 是无连接的，B 先启动、A 还没起来时首个 Init 直接丢失；
// 早前只在失败后降级一次、之后再不重发，于是「谁先启动谁永远连不上」。
//
// 返回本次真正重发的 peer 数（诊断/测试用）。
func (f *HandshakeFSM) RetryPending(now time.Time, after time.Duration) int {
	type resend struct {
		peer    NodeID
		msg     []byte
		version byte
	}
	var todo []resend

	f.mu.Lock()
	for peer, p := range f.pending {
		if p.state != HSWaitMsg2 || len(p.lastMsg) == 0 {
			continue // 只重发「发起方等 msg2」的 Init
		}
		if now.Sub(p.sentAt) < after {
			continue
		}
		version := f.wireVersions.VersionFor(peer)
		// 从未学到该对端任何帧 ⇒ 首次降级到 v1（v1 节点才解得开）
		if !p.downgraded && !f.wireVersions.Known(peer) {
			p.downgraded = true
			f.wireVersions.ForceVersion(peer, WireVersionV1)
			version = WireVersionV1
		}
		p.sentAt = now
		p.attempts++
		todo = append(todo, resend{peer: peer, msg: p.lastMsg, version: version})
	}
	f.mu.Unlock()

	for _, r := range todo {
		frame, err := EncodeHandshakeFrame(f.selfID, r.peer, r.msg, r.version)
		if err != nil || f.sendFn == nil {
			continue
		}
		_ = f.sendFn(r.peer, frame)
	}
	return len(todo)
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
		// 双向同时发起（真机：中继 AuthAccept 后两端都会 StartOutboundForce）：
		// 大 NodeId 一侧收到小 NodeId 的 msg1 时，它的 pending 正是「等 msg2」，
		// 若直接当 msg2 解，就会 chacha20poly1305: message authentication failed，
		// 双方永远卡在握手中。破对称规则：**小 NodeId 保持发起方**，大的一侧放弃
		// 自己的 pending 改当响应方（与 onInit 里忽略对端 Init 的规则对称）。
		if !f.IsInitiator(parsed.Src) {
			f.mu.Lock()
			delete(f.pending, parsed.Src)
			f.mu.Unlock()
			return true, f.onInit(parsed)
		}
		return true, f.onMsg2(parsed, p)
	case HSWaitKeyMaterial:
		return true, f.onKeyMaterial(parsed, p)
	default:
		return true, fmt.Errorf("handshake fsm: 来自 %x 的握手帧状态异常 %s", parsed.Src[:4], p.state)
	}
}

// onInit 响应方收 msg1 → 发 msg2 → 等 KeyMaterial（session.rs:925-958）。
func (f *HandshakeFSM) onInit(parsed *Frame) error {
	// 破对称：本端更小、且已有该对端的 pending ⇒ 忽略对端 Init（避免双向同时发起）。
	// 但**没有 pending 时仍接受**：对端可能刚重启（会话失效），它主动发 Init 是唯一
	// 的恢复通路；旧会话保持到 KeyMaterial 装好为止，伪造 Init 无法直接打掉它。
	if f.IsInitiator(parsed.Src) {
		f.mu.Lock()
		_, hasPending := f.pending[parsed.Src]
		f.mu.Unlock()
		if hasPending {
			return nil
		}
	}
	// 响应方去重：发起方会周期性重发**同一份** Init（UDP 无连接，5s 一次）。
	// 每收到一次就重建 responder 握手，会让后续 KeyMaterial 对不上刚生成的那份
	// msg2 —— 真机症状：`恢复 KeyMaterial 失败` 每 5s 刷一次，永远握不上。
	f.mu.Lock()
	if cur, ok := f.pending[parsed.Src]; ok && cur.state == HSWaitKeyMaterial &&
		time.Since(cur.started) < 5*time.Second {
		f.mu.Unlock()
		return nil
	}
	f.mu.Unlock()

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
	// 回帧版本跟随该对端：已学到 v1 就必须用 v1，否则旧节点丢帧。
	version := f.wireVersions.VersionFor(dst)
	frame, err := EncodeHandshakeFrame(f.selfID, dst, msg, version)
	if err != nil {
		return err
	}
	if f.sendFn == nil {
		return fmt.Errorf("handshake fsm: sendFn 未设置")
	}
	return f.sendFn(dst, frame)
}

// Reset 丢弃某对端的会话与进行中的握手，允许重新握手。
//
// 真机场景：一端重启后，另一端仍持有**已失效的会话**（密钥是旧的），
// 它会用旧密钥继续发帧，对方解不开、也不会主动重发 Init ⇒ 双方永远连不上。
// 由生命周期按「长时间没有成功解密」判定后调用。
func (f *HandshakeFSM) Reset(peer NodeID) {
	f.mu.Lock()
	delete(f.sessions, peer)
	delete(f.pending, peer)
	f.mu.Unlock()
}

// HasSession 报告是否已有会话（诊断用）。
func (f *HandshakeFSM) HasSession(peer NodeID) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.sessions[peer]
	return ok
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

