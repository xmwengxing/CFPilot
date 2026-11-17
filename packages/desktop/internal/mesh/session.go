package mesh

import (
	"crypto/cipher"
	"crypto/rand"
	"fmt"
	"time"

	"github.com/flynn/noise"
)

// E2E 会话（契约 §2.2/§3，对齐 MobiHop session.rs）。
//
// 握手完成后：
//   - 发起方随机 data_key(32B)，epoch_id = BLAKE3(data_key)[0..4]
//   - material = data_key || epoch_id(4B BE)，用 Noise 传输态加密 → KeyMaterial 帧
//   - 双方从 data_key 派生方向密钥（i2r/r2i），按角色选 send/recv
//   - 数据帧：counter 填 32B 头，头编码作 AAD，nonce = epoch||counter
//   - 解密：先 AEAD 后防重放（2048 位窗口）
//   - rekey：counter >= 2^32 或 600s

// Role 是会话角色（决定方向密钥取向）。
type Role int

const (
	RoleInitiator Role = iota
	RoleResponder
)

// Session 是端到端加密会话。
type Session struct {
	epochID       uint32
	sendAEAD      cipher.AEAD
	recvAEAD      cipher.AEAD
	sendCounter   uint64
	recvWindow    *ReplayWindow
	establishedAt time.Time
	role          Role
}

// NewSessionFromDataKey 由 data_key + epoch + 角色构造会话（session.rs:181-196）。
func NewSessionFromDataKey(dataKey [32]byte, epochID uint32, role Role) (*Session, error) {
	i2r := DeriveDirectionalKey(dataKey, DirKeyI2R)
	r2i := DeriveDirectionalKey(dataKey, DirKeyR2I)
	var sendKey, recvKey [32]byte
	if role == RoleInitiator {
		sendKey, recvKey = i2r, r2i
	} else {
		sendKey, recvKey = r2i, i2r
	}
	sendAEAD, err := NewAEAD(sendKey)
	if err != nil {
		return nil, fmt.Errorf("mesh session: send AEAD 失败: %w", err)
	}
	recvAEAD, err := NewAEAD(recvKey)
	if err != nil {
		return nil, fmt.Errorf("mesh session: recv AEAD 失败: %w", err)
	}
	return &Session{
		epochID:       epochID,
		sendAEAD:      sendAEAD,
		recvAEAD:      recvAEAD,
		recvWindow:    NewReplayWindow(),
		establishedAt: time.Now(),
		role:          role,
	}, nil
}

// InitiatorKeyMaterial 生成发起方 KeyMaterial wire（session.rs:240-253）。
// wire = Noise传输态.Encrypt(data_key || epoch_be)
func InitiatorKeyMaterial(noiseSend *noise.CipherState) (wire []byte, sess *Session, err error) {
	var dataKey [32]byte
	if _, err = rand.Read(dataKey[:]); err != nil {
		return nil, nil, fmt.Errorf("mesh session: 生成 data_key 失败: %w", err)
	}
	epoch := DeriveEpochID(dataKey)
	material := make([]byte, 0, 36)
	material = append(material, dataKey[:]...)
	material = append(material, byte(epoch>>24), byte(epoch>>16), byte(epoch>>8), byte(epoch))
	// Noise 传输态加密（aad=nil，与 MobiHop transport.encrypt 一致）
	wire, err = noiseSend.Encrypt(nil, nil, material)
	if err != nil {
		return nil, nil, fmt.Errorf("mesh session: 加密 KeyMaterial 失败: %w", err)
	}
	sess, err = NewSessionFromDataKey(dataKey, epoch, RoleInitiator)
	return wire, sess, err
}

// ResponderFromKeyMaterial 从 KeyMaterial wire 恢复会话（session.rs:256-267）。
func ResponderFromKeyMaterial(noiseRecv *noise.CipherState, wire []byte) (*Session, error) {
	material, err := noiseRecv.Decrypt(nil, nil, wire)
	if err != nil {
		return nil, fmt.Errorf("mesh session: 解密 KeyMaterial 失败: %w", err)
	}
	if len(material) != 36 {
		return nil, fmt.Errorf("mesh session: KeyMaterial 长度 %d != 36", len(material))
	}
	var dataKey [32]byte
	copy(dataKey[:], material[:32])
	epoch := uint32(material[32])<<24 | uint32(material[33])<<16 | uint32(material[34])<<8 | uint32(material[35])
	return NewSessionFromDataKey(dataKey, epoch, RoleResponder)
}

// EpochID 返回当前 epoch（nonce 高 32 位）。
func (s *Session) EpochID() uint32 { return s.epochID }

// SendCounter 返回下一个发送 counter（供调用方填 32B 头）。
func (s *Session) SendCounter() uint64 { return s.sendCounter }

// Encrypt 加密载荷，返回 (counter, ciphertext‖tag)。
// 调用方应把 counter 填入帧头，并用该头的 AADBytes() 作为 aad 传入。
func (s *Session) Encrypt(aad, plaintext []byte) (uint64, []byte, error) {
	counter := s.sendCounter
	nonce := BuildNonce(s.epochID, counter)
	ct := Seal(s.sendAEAD, nonce, aad, plaintext)
	s.sendCounter++
	return counter, ct, nil
}

// Decrypt 解密并防重放：先 AEAD 校验，后窗口判定（session.rs:220-230）。
func (s *Session) Decrypt(counter uint64, aad, ciphertext []byte) ([]byte, error) {
	nonce := BuildNonce(s.epochID, counter)
	pt, err := Open(s.recvAEAD, nonce, aad, ciphertext)
	if err != nil {
		return nil, err // AEAD 失败不污染窗口
	}
	if !s.recvWindow.CheckAndUpdate(counter) {
		return nil, fmt.Errorf("mesh session: 重放/过旧 counter=%d", counter)
	}
	return pt, nil
}

// NeedsRekey 是否触发重握手（session.rs:233-236：min(2^32 包, 600s)）。
func (s *Session) NeedsRekey() bool {
	return s.sendCounter >= RekeyCounterThreshold || time.Since(s.establishedAt) >= RekeyAgeSec*time.Second
}

// ReplayHighest 返回已接受的最高 counter（诊断用）。
func (s *Session) ReplayHighest() uint64 { return s.recvWindow.Highest() }
