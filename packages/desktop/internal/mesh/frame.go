package mesh

import (
	"encoding/binary"
	"fmt"
)

// Frame 是 MobiHop 的 32B 头 + 载荷帧（契约 §1，ADR-0016 v2）。
//
// 字节布局（全大端，32B 不变）：
//
//	0    magic=0x4D
//	1    version：0x01（旧）或 0x02（当前默认）
//	2    msg_type
//	3    flags
//	4    ttl (<=64)
//	5    key_meta：v1 必须为 0；v2 = 高 4 位 key_slot，低 4 位 qos_class（恒 0）
//	6..8 payload_len u16 (<=1400)
//	8..16 src (8B NodeId)
//	16..24 dst (8B NodeId)
//	24..32 counter u64
//	32..  payload
//
// ## 版本语义（ADR-0016，已冻结）
//
// 接受集合固定为 {0x01, 0x02}；出站默认 0x02。`Version == 0` 表示「用当前默认」。
// 对已知 v1 对端发帧时**必须**显式把 Version 置 0x01 —— 并且此时 key_meta 自动
// 归零（v1 节点会因 buf[5] != 0 丢弃整帧）。
//
// ## 中继红线
//
// 中继只允许改 buf[4]（TTL）与 buf[3] 的 RELAYED 位。AAD 覆盖 version 与 key_meta，
// 任何「顺手规范化」都会让接收侧 AEAD 失败。
type Frame struct {
	// Version 是线速版本：0 = 默认（v2），1 = v1，2 = v2。
	Version byte
	Type    MsgType
	Flags   byte
	TTL     byte
	// KeyMeta 是 v2 的 buf[5]：高 4 位 key_slot，低 4 位 qos_class。
	KeyMeta byte
	Payload []byte
	Src     [8]byte
	Dst     [8]byte
	Counter uint64
}

// WireVersion 返回本帧实际写出的版本字节。
func (f *Frame) WireVersion() byte {
	if f.Version == 0 {
		return WireVersionDefault
	}
	return f.Version
}

// EffectiveKeyMeta 返回本帧实际写出的 buf[5]：
// v1 强制为 0（否则旧节点按 ReservedField 丢弃），v2 原样。
func (f *Frame) EffectiveKeyMeta() byte {
	if f.WireVersion() == WireVersionV1 {
		return 0
	}
	return f.KeyMeta
}

// KeySlot 返回 key_slot（v1 恒 0）。
func (f *Frame) KeySlot() byte { return f.EffectiveKeyMeta() >> 4 }

// QoSClass 返回 qos_class（当前恒 0，读取方不得据它做转发决策）。
func (f *Frame) QoSClass() byte { return f.EffectiveKeyMeta() & 0x0f }

// Encode 把帧编码为字节（契约 §1.1）。
// 调用方应保证 TTL<=64、len(Payload)<=1400；这里也做防御性校验。
func (f *Frame) Encode() ([]byte, error) {
	if f.TTL > MaxTTL {
		return nil, fmt.Errorf("mesh frame: TTL %d 超过 %d", f.TTL, MaxTTL)
	}
	if len(f.Payload) > MaxPayload {
		return nil, fmt.Errorf("mesh frame: payload %d 超过 %d", len(f.Payload), MaxPayload)
	}
	if f.Flags&FlagReserved != 0 {
		return nil, fmt.Errorf("mesh frame: flags 保留位非零 %#x", f.Flags)
	}
	v := f.WireVersion()
	if v != WireVersionV1 && v != WireVersionV2 {
		return nil, fmt.Errorf("%w: version=%#x", ErrInvalidVersion, v)
	}
	buf := make([]byte, HeaderLen+len(f.Payload))
	buf[0] = MagicByte
	buf[1] = v
	buf[2] = byte(f.Type)
	buf[3] = f.Flags
	buf[4] = f.TTL
	buf[5] = f.EffectiveKeyMeta()
	binary.BigEndian.PutUint16(buf[6:8], uint16(len(f.Payload)))
	copy(buf[8:16], f.Src[:])
	copy(buf[16:24], f.Dst[:])
	binary.BigEndian.PutUint64(buf[24:32], f.Counter)
	copy(buf[32:], f.Payload)
	return buf, nil
}

// Decode 解析一帧（契约 §1.1）。
// 错误类型与 Rust 侧对齐：Truncated / InvalidType / InvalidFlags / TtlOutOfRange /
// ReservedField / Oversized / InvalidVersion。调用方可用 errors.Is 判断。
func Decode(buf []byte) (*Frame, error) {
	if len(buf) < HeaderLen {
		return nil, fmt.Errorf("%w: 需要 %d 字节，实际 %d", ErrTruncated, HeaderLen, len(buf))
	}
	if buf[0] != MagicByte {
		return nil, fmt.Errorf("%w: magic=%#x", ErrInvalidMagic, buf[0])
	}
	switch buf[1] {
	case WireVersionV1:
		// v1：保留字节必须为 0。伪造 v1 帧只会让本机把该对端降级到单槽
		// （仍是 AEAD 认证会话），不损机密性。
		if buf[5] != 0 {
			return nil, fmt.Errorf("%w: reserved=%#x", ErrReservedField, buf[5])
		}
	case WireVersionV2:
		// v2：key_meta 任意（中继不解密，只需原样透传）
	default:
		return nil, fmt.Errorf("%w: version=%#x", ErrInvalidVersion, buf[1])
	}
	t := MsgType(buf[2])
	if !t.valid() {
		return nil, fmt.Errorf("%w: type=%#x", ErrInvalidType, buf[2])
	}
	flags := buf[3]
	if flags&FlagReserved != 0 {
		return nil, fmt.Errorf("%w: flags=%#x", ErrInvalidFlags, flags)
	}
	ttl := buf[4]
	if ttl > MaxTTL {
		return nil, fmt.Errorf("%w: ttl=%d", ErrTtlOutOfRange, ttl)
	}
	payloadLen := binary.BigEndian.Uint16(buf[6:8])
	if int(payloadLen) > MaxPayload {
		return nil, fmt.Errorf("%w: payload_len=%d", ErrOversized, payloadLen)
	}
	need := HeaderLen + int(payloadLen)
	if len(buf) < need {
		return nil, fmt.Errorf("%w: 需要 %d 字节，实际 %d", ErrTruncated, need, len(buf))
	}
	f := &Frame{
		Version: buf[1],
		Type:    t,
		Flags:   flags,
		TTL:     ttl,
		KeyMeta: buf[5],
		Payload: append([]byte(nil), buf[32:need]...),
		Counter: binary.BigEndian.Uint64(buf[24:32]),
	}
	copy(f.Src[:], buf[8:16])
	copy(f.Dst[:], buf[16:24])
	return f, nil
}

// AADBytes 返回用于 E2E AEAD 的 32B AAD（契约 §3.1，header.rs:249）。
//
// 归一化规则：
//  1. ttl 置 0；
//  2. 清除 flags 的 RELAYED (0x02) 位；
//  3. 其余字段原样 —— **包含 version 与 key_meta**（ADR-0016 明确纳入认证）。
//
// ⇒ 中继每跳 TTL-1 并置 RELAYED 不影响 E2E 解密；
//   但中继若「规范化」version/key_meta，接收侧 AEAD 必然失败。
func (f *Frame) AADBytes() []byte {
	aad := make([]byte, HeaderLen)
	aad[0] = MagicByte
	aad[1] = f.WireVersion()
	aad[2] = byte(f.Type)
	aad[3] = f.Flags &^ FlagRelayed // 清 RELAYED，保留其它位
	aad[4] = 0                      // ttl 置 0
	aad[5] = f.EffectiveKeyMeta()
	binary.BigEndian.PutUint16(aad[6:8], uint16(len(f.Payload)))
	copy(aad[8:16], f.Src[:])
	copy(aad[16:24], f.Dst[:])
	binary.BigEndian.PutUint64(aad[24:32], f.Counter)
	return aad
}

func (t MsgType) valid() bool {
	return t >= MsgHandshake && t <= MsgUdpProbe
}

// 解析错误哨兵（配合 errors.Is）
var (
	ErrTruncated      = fmt.Errorf("mesh frame: truncated")
	ErrInvalidMagic   = fmt.Errorf("mesh frame: invalid magic")
	ErrInvalidVersion = fmt.Errorf("mesh frame: invalid version")
	ErrInvalidType    = fmt.Errorf("mesh frame: invalid type")
	ErrInvalidFlags   = fmt.Errorf("mesh frame: invalid flags")
	ErrTtlOutOfRange  = fmt.Errorf("mesh frame: ttl out of range")
	ErrReservedField  = fmt.Errorf("mesh frame: reserved field")
	ErrOversized      = fmt.Errorf("mesh frame: oversized")
)
