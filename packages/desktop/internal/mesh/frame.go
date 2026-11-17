package mesh

import (
	"encoding/binary"
	"fmt"
)

// Frame 是 MobiHop 的 32B 头 + 载荷帧（契约 §1）。
//
// 字节布局（全大端）：
//
//	0    magic=0x4D
//	1    version=0x01
//	2    msg_type
//	3    flags
//	4    ttl (<=64)
//	5    reserved=0
//	6..8 payload_len u16 (<=1400)
//	8..16 src (8B NodeId)
//	16..24 dst (8B NodeId)
//	24..32 counter u64
//	32..  payload
type Frame struct {
	Type    MsgType
	Flags   byte
	TTL     byte
	Payload []byte
	Src     [8]byte
	Dst     [8]byte
	Counter uint64
}

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
	buf := make([]byte, HeaderLen+len(f.Payload))
	buf[0] = MagicByte
	buf[1] = VersionByte
	buf[2] = byte(f.Type)
	buf[3] = f.Flags
	buf[4] = f.TTL
	buf[5] = 0 // reserved
	binary.BigEndian.PutUint16(buf[6:8], uint16(len(f.Payload)))
	copy(buf[8:16], f.Src[:])
	copy(buf[16:24], f.Dst[:])
	binary.BigEndian.PutUint64(buf[24:32], f.Counter)
	copy(buf[32:], f.Payload)
	return buf, nil
}

// Decode 解析一帧（契约 §1.1）。
// 错误类型与 Rust 侧对齐：Truncated / InvalidType / InvalidFlags / TtlOutOfRange /
// ReservedField / Oversized。调用方可用 errors.Is 判断。
func Decode(buf []byte) (*Frame, error) {
	if len(buf) < HeaderLen {
		return nil, fmt.Errorf("%w: 需要 %d 字节，实际 %d", ErrTruncated, HeaderLen, len(buf))
	}
	if buf[0] != MagicByte {
		return nil, fmt.Errorf("%w: magic=%#x", ErrInvalidMagic, buf[0])
	}
	if buf[1] != VersionByte {
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
	if buf[5] != 0 {
		return nil, fmt.Errorf("%w: reserved=%#x", ErrReservedField, buf[5])
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
		Type:    t,
		Flags:   flags,
		TTL:     ttl,
		Payload: append([]byte(nil), buf[32:need]...),
		Counter: binary.BigEndian.Uint64(buf[24:32]),
	}
	copy(f.Src[:], buf[8:16])
	copy(f.Dst[:], buf[16:24])
	return f, nil
}

// AADBytes 返回用于 E2E AEAD 的 32B AAD（契约 §3.1，header.rs:215-222）。
//
// 归一化规则：
//  1. ttl 置 0；
//  2. 清除 flags 的 RELAYED (0x02) 位；
//  3. 其余字段原样（magic/version/type/ENCRYPTED/ACK_REQ/reserved/payload_len/src/dst/counter）。
//
// ⇒ 中继每跳 TTL-1 并置 RELAYED 不影响 E2E 解密。
func (f *Frame) AADBytes() []byte {
	aad := make([]byte, HeaderLen)
	aad[0] = MagicByte
	aad[1] = VersionByte
	aad[2] = byte(f.Type)
	aad[3] = f.Flags &^ FlagRelayed // 清 RELAYED，保留其它位
	aad[4] = 0                      // ttl 置 0
	aad[5] = 0                      // reserved
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
