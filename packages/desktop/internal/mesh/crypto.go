package mesh

import (
	"crypto/cipher"
	"encoding/binary"
	"fmt"

	"github.com/flynn/noise"
	"github.com/zeebo/blake3"
	"golang.org/x/crypto/chacha20poly1305"
)

// 数据面 AEAD 与密钥派生（契约 §2.3 / §3）。
//
// 所有字节级细节来自 MESH_INTEGRATION_CONTRACT.md（main@1ccfdc1）：
//   - 数据面 AEAD = ring ChaCha20-Poly1305 等价（x/crypto chacha20poly1305，RFC 8439）
//   - nonce = epoch_id(4B BE) || counter(8B BE)
//   - tag 16B 追加在密文尾部（chacha20poly1305.Seal/Open 默认行为）
//   - AAD = 32B 归一化头（Frame.AADBytes）
//   - 方向密钥 = BLAKE3 keyed(data_key, "mobihop/i2r"|"mobihop/r2i")

// DeriveNetworkID 计算 network_id = BLAKE3(network_name)（契约 §2.3，kdf.rs:8-11）。
func DeriveNetworkID(networkName string) [32]byte {
	return blake3.Sum256([]byte(networkName))
}

// DerivePSK 计算 pre-shared key（契约 §2.3，kdf.rs:15-18）：
//
//	material = network_name || 0x00 || secret
//	psk      = BLAKE3::derive_key("mobihop/psk/v1", material)
//
// 注意 zeebo/blake3 的 DeriveKey(context, key_material) 签名：
// 第一个参数是 context（字符串），第二个是输入 material。
func DerivePSK(networkName, secret string) [32]byte {
	material := make([]byte, 0, len(networkName)+1+len(secret))
	material = append(material, []byte(networkName)...)
	material = append(material, 0x00)
	material = append(material, []byte(secret)...)
	var out [32]byte
	h := blake3.NewDeriveKey(PskContext)
	_, _ = h.Write(material)
	copy(out[:], h.Sum(nil))
	return out
}

// DeriveRoomTag 计算盲中继房间标签（契约 §4.6）：
//
//	room_tag = BLAKE3_keyed(psk, "mobihop/relay-room/v1")[0..8]
//
// 即把 psk 当 key、上串当 message 的 keyed hash。
func DeriveRoomTag(psk [32]byte) [8]byte {
	h, _ := blake3.NewKeyed(psk[:]) // key 32B 恒合法，err 不可能
	_, _ = h.Write([]byte("mobihop/relay-room/v1"))
	var out [8]byte
	copy(out[:], h.Sum(nil)[:8])
	return out
}

// DeriveEpochID 计算 epoch_id = BLAKE3(data_key)[0..4] 大端（契约 §3.3，session.rs:163-167）。
//
// ⚠️ 权威定义：epoch_id 由 data_key 派生，不是随机。
func DeriveEpochID(dataKey [32]byte) uint32 {
	h := blake3.Sum256(dataKey[:])
	return binary.BigEndian.Uint32(h[:4])
}

// DeriveDirectionalKey 计算方向密钥（契约 §3.2，session.rs:181-190）：
//
//	i2r = BLAKE3_keyed(data_key, "mobihop/i2r")  // 发起方 → 响应方
//	r2i = BLAKE3_keyed(data_key, "mobihop/r2i")  // 响应方 → 发起方
func DeriveDirectionalKey(dataKey [32]byte, label string) [32]byte {
	h, _ := blake3.NewKeyed(dataKey[:]) // key 32B 恒合法，err 不可能
	_, _ = h.Write([]byte(label))
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// BuildNonce 构造 12B AEAD nonce（契约 §3，aead.rs:26-30）：
//
//	nonce[0..4] = epoch_id.to_be_bytes()
//	nonce[4..12] = counter.to_be_bytes()
func BuildNonce(epochID uint32, counter uint64) [NonceLen]byte {
	var nonce [NonceLen]byte
	binary.BigEndian.PutUint32(nonce[0:4], epochID)
	binary.BigEndian.PutUint64(nonce[4:12], counter)
	return nonce
}

// NewAEAD 用方向密钥创建 ChaCha20-Poly1305。
func NewAEAD(directionalKey [32]byte) (cipher.AEAD, error) {
	aead, err := chacha20poly1305.New(directionalKey[:])
	if err != nil {
		return nil, fmt.Errorf("mesh aead: 创建失败: %w", err)
	}
	return aead, nil
}

// Seal 加密一帧的载荷：ciphertext‖tag（tag 16B 自动追加在尾部）。
// aad 必须是 Frame.AADBytes()（32B 归一化头）。
func Seal(aead cipher.AEAD, nonce [NonceLen]byte, aad, plaintext []byte) []byte {
	return aead.Seal(nil, nonce[:], plaintext, aad)
}

// Open 解密并校验 AAD；tag 不符或 AAD 被篡改会报错。
func Open(aead cipher.AEAD, nonce [NonceLen]byte, aad, ciphertext []byte) ([]byte, error) {
	return aead.Open(nil, nonce[:], ciphertext, aad)
}

// NoiseConfig 返回与 MobiHop 对齐的 Noise 配置（契约 §2.1-2.2）。
//
// snow 的模式串 Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s 对应 flynn/noise：
//   - CipherSuite: DH25519 + ChaChaPoly + BLAKE2s
//   - Pattern:     HandshakeIK（IK）
//   - PresharedKey + PresharedKeyPlacement = 2 ⇒ IKpsk2（psk@2）
//   - Prologue:    network_id 32B
//
// ⚠️ 互通关键点：flynn/noise 的 IK + psk@2 是否与 snow 的 IKpsk2 字节级一致，
// 必须用 MobiHop 的握手向量实测确认（见 noise.go 与互通测试）；这里先按参数对齐。
func NoiseConfig(psk [32]byte, prologue []byte, staticKey noise.DHKey, initiator bool) noise.Config {
	ciphersuite := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	return noise.Config{
		CipherSuite:           ciphersuite,
		Pattern:               noise.HandshakeIK,
		Initiator:             initiator,
		Prologue:              append([]byte(nil), prologue...),
		StaticKeypair:         staticKey,
		PresharedKey:          append([]byte(nil), psk[:]...),
		PresharedKeyPlacement: PskIndex, // psk@2（契约 §2.1，session.rs:102/139）
	}
}

// PskAt 返回 PSK 在握手消息中的位置（契约 §2.1：index 2）。
const PskAt = PskIndex
