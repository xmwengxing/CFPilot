package mesh

import (
	"fmt"

	"github.com/flynn/noise"
)

// Noise 握手状态机（Phase 3b，契约 §2）。
//
// MobiHop 握手三帧（control.rs:44-55）：
//  1. Init  { noise } —— msg1（-> e, es, s, ss）
//  2. Reply { noise } —— msg2（<- e, ee, se, psk）
//  3. KeyMaterial { wire } —— 用 Noise 传输态加密的会话密钥（应用层，非握手帧）
//
// flynn/noise 的 WriteMessage/ReadMessage 返回 (msg/payload, cs1, cs2, err)：
//   - 中间步骤返回的 cs 为 nil；
//   - 握手完成那一步返回两个 CipherState（cs1=本方发→对方收，cs2=对方发→本方收）。
// 本封装把 states 保存在 Handshake 里，Call 方可在任一步后取。
//
// ⚠️ 跨语言互通（flynn/noise ↔ snow）尚未用 golden 向量实测（契约 §9 明确未做）。
//    本实现按参数对齐（IK + psk@2 + ChaChaPoly + BLAKE2s + prologue=network_id）。
//    互通验证列为 Phase 3b 待办（需从 MobiHop 侧导出确定性握手向量）。

// Handshake 封装 Noise 握手状态与最终的 CipherStates。
type Handshake struct {
	state  *noise.HandshakeState
	role   string
	csSend *noise.CipherState // 本方发 → 对方收
	csRecv *noise.CipherState // 对方发 → 本方收
}

func (h *Handshake) setStates(cs1, cs2 *noise.CipherState) {
	if cs1 == nil {
		return // 握手未完成
	}
	if h.role == "initiator" {
		h.csSend, h.csRecv = cs1, cs2
	} else {
		// 响应方的 cs1/cs2 方向与发起方相反（flynn/noise 语义）
		h.csRecv, h.csSend = cs1, cs2
	}
}

// SendState / RecvState 返回握手完成后的收发 CipherState（未完成时为 nil）。
func (h *Handshake) SendState() *noise.CipherState { return h.csSend }
func (h *Handshake) RecvState() *noise.CipherState { return h.csRecv }

// NewInitiatorHandshake 创建发起方握手状态。
// staticKey 是 X25519 隧道静态密钥；peerStatic 是对端静态公钥（IK 需要预知）。
func NewInitiatorHandshake(psk [32]byte, prologue []byte, staticKey, peerStatic noise.DHKey) (*Handshake, error) {
	cfg := NoiseConfig(psk, prologue, staticKey, true)
	cfg.PeerStatic = peerStatic.Public
	state, err := noise.NewHandshakeState(cfg)
	if err != nil {
		return nil, fmt.Errorf("mesh noise: 发起方握手初始化失败: %w", err)
	}
	return &Handshake{state: state, role: "initiator"}, nil
}

// NewResponderHandshake 创建响应方握手状态。
func NewResponderHandshake(psk [32]byte, prologue []byte, staticKey noise.DHKey) (*Handshake, error) {
	cfg := NoiseConfig(psk, prologue, staticKey, false)
	state, err := noise.NewHandshakeState(cfg)
	if err != nil {
		return nil, fmt.Errorf("mesh noise: 响应方握手初始化失败: %w", err)
	}
	return &Handshake{state: state, role: "responder"}, nil
}

// WriteMessage 写出一条握手消息（IK：发起方 msg1 / 响应方 msg2）。
// 握手完成那一步会填充 SendState/RecvState。
func (h *Handshake) WriteMessage(payload []byte) ([]byte, error) {
	msg, cs1, cs2, err := h.state.WriteMessage(nil, payload)
	if err != nil {
		return nil, fmt.Errorf("mesh noise: 写握手消息失败: %w", err)
	}
	h.setStates(cs1, cs2)
	return msg, nil
}

// ReadMessage 读一条握手消息，返回对端 payload。
// 握手完成那一步会填充 SendState/RecvState。
func (h *Handshake) ReadMessage(msg []byte) ([]byte, error) {
	payload, cs1, cs2, err := h.state.ReadMessage(nil, msg)
	if err != nil {
		return nil, fmt.Errorf("mesh noise: 读握手消息失败: %w", err)
	}
	h.setStates(cs1, cs2)
	return payload, nil
}

// Complete 是 ReadMessage 的别名（语义：读 msg2 完成握手），供发起方调用。
func (h *Handshake) Complete(msg []byte) ([]byte, error) { return h.ReadMessage(msg) }

// CipherStates 返回 (send, recv) 两个 CipherState；握手未完成返回 nil。
func (h *Handshake) CipherStates() (*noise.CipherState, *noise.CipherState) {
	return h.csSend, h.csRecv
}
