package scan

// WebSocket 帧编解码（只覆盖探测需要的 text / binary / close 帧）。
//
// 对照 CLI packages/cli/src/scan/true-probe.ts:380-439。两端语义必须一致，
// 否则桌面版发出的帧数据面解不出来，阶段二会全军覆没。

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"math"
)

// wsFrame 是一帧解析结果。
type wsFrame struct {
	opcode  byte // 1 = text，2 = binary，8 = close
	payload []byte
}

// encodeClientFrame 构造客户端帧。
//
// ⚠️ 客户端帧**必须掩码**（RFC 6455 §5.3），否则数据面会直接丢弃。
// 给 /__edge_probe 发 PING 必须用 opcode 1（text）：数据面用
// `typeof event.data === 'string'` 判定，binary 帧会被当成空字符串忽略
// （真机实测 8/8 全部超时）。
func encodeClientFrame(payload []byte, opcode byte) ([]byte, error) {
	if len(payload) > math.MaxInt32 {
		return nil, errors.New("WS 帧过大")
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return nil, err
	}

	var head []byte
	n := len(payload)
	switch {
	case n < 126:
		head = []byte{0x80 | opcode, 0x80 | byte(n)}
	case n <= math.MaxUint16:
		head = make([]byte, 4)
		head[0] = 0x80 | opcode
		head[1] = 0xfe
		binary.BigEndian.PutUint16(head[2:], uint16(n))
	default:
		head = make([]byte, 10)
		head[0] = 0x80 | opcode
		head[1] = 0xff
		binary.BigEndian.PutUint64(head[2:], uint64(n))
	}

	out := make([]byte, 0, len(head)+4+n)
	out = append(out, head...)
	out = append(out, mask...)
	for i, b := range payload {
		out = append(out, b^mask[i%4])
	}
	return out, nil
}

// decodeServerFrame 从缓冲区解析一帧服务端帧（服务端帧不带掩码）。
// ok=false 表示数据还不够一帧；返回的 payload 是独立拷贝。
func decodeServerFrame(buf []byte) (frame wsFrame, rest []byte, ok bool) {
	if len(buf) < 2 {
		return
	}
	opcode := buf[0] & 0x0f
	len7 := buf[1] & 0x7f
	var offset int
	var payloadLen uint64
	switch {
	case len7 < 126:
		offset = 2
		payloadLen = uint64(len7)
	case len7 == 126:
		if len(buf) < 4 {
			return
		}
		offset = 4
		payloadLen = uint64(binary.BigEndian.Uint16(buf[2:4]))
	default:
		if len(buf) < 10 {
			return
		}
		offset = 10
		payloadLen = binary.BigEndian.Uint64(buf[2:10])
	}
	// 防止畸形长度把内存吃穿
	if payloadLen > uint64(maxFramePayload) {
		return wsFrame{}, nil, false
	}
	total := uint64(offset) + payloadLen
	if uint64(len(buf)) < total {
		return
	}
	payload := make([]byte, int(payloadLen))
	copy(payload, buf[offset:total])
	return wsFrame{opcode: opcode, payload: payload}, buf[total:], true
}

// maxFramePayload 是探测路径接受的单个 WS 帧上限（1 MiB 足够放 PONG / 首包）。
const maxFramePayload = 1024 * 1024
