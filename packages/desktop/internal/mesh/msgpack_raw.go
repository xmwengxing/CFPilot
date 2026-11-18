package mesh

import "fmt"

// MessagePack 原始字节工具：为 H1-4 `sig_version = 2` 的签名基线服务。
//
// ## 为什么不能靠本地结构体重编码
//
// v2 的签名基线是「**线上原始载荷** 去掉 signature / raw_signed_bytes 两个键后，
// 按 named 形式重编码」。它要求**保留原始 map 的键顺序**：
// 本地结构体（甚至同一份 Go struct）重新 Marshal 时，字段顺序、可选字段是否出现
// 都可能与发送方不同，验签必然失败。
//
// 所以这里只在字节层操作：解析顶层 map 的键值对，按原顺序拼接、原样拷贝值字节。

const (
	msgpackKeySignature     = "signature"
	msgpackKeyRawSigned     = "raw_signed_bytes"
	msgpackSignaturePadding = 64
)

// skipMsgpackValue 返回 `b[pos]` 起一个完整 MessagePack 值之后的偏移。
func skipMsgpackValue(b []byte, pos int) (int, error) {
	if pos < 0 || pos >= len(b) {
		return 0, fmt.Errorf("msgpack: 偏移越界 %d", pos)
	}
	m := b[pos]
	switch {
	case m <= 0x7f: // positive fixint
		return pos + 1, nil
	case m >= 0xe0: // negative fixint
		return pos + 1, nil
	case m >= 0x80 && m <= 0x8f: // fixmap
		return skipMapBody(b, pos+1, int(m&0x0f))
	case m >= 0x90 && m <= 0x9f: // fixarray
		return skipArrayBody(b, pos+1, int(m&0x0f))
	case m >= 0xa0 && m <= 0xbf: // fixstr
		return skipBytes(b, pos+1, int(m&0x1f))
	case m >= 0xc0:
		switch m {
		case 0xc0, 0xc2, 0xc3: // nil / false / true
			return pos + 1, nil
		case 0xc4, 0xd9: // bin8 / str8
			return skipSized(b, pos, 1)
		case 0xc5, 0xda: // bin16 / str16
			return skipSized(b, pos, 2)
		case 0xc6, 0xdb: // bin32 / str32
			return skipSized(b, pos, 4)
		case 0xc7: // ext8：长度 1B + 类型 1B + 数据
			return skipExt(b, pos, 1)
		case 0xc8: // ext16
			return skipExt(b, pos, 2)
		case 0xc9: // ext32
			return skipExt(b, pos, 4)
		case 0xca: // float32
			return pos + 5, nil
		case 0xcb: // float64
			return pos + 9, nil
		case 0xcc, 0xd0: // uint8 / int8
			return pos + 2, nil
		case 0xcd, 0xd1: // uint16 / int16
			return pos + 3, nil
		case 0xce, 0xd2: // uint32 / int32
			return pos + 5, nil
		case 0xcf, 0xd3: // uint64 / int64
			return pos + 9, nil
		case 0xd4: // fixext1
			return pos + 3, nil
		case 0xd5: // fixext2
			return pos + 4, nil
		case 0xd6: // fixext4
			return pos + 6, nil
		case 0xd7: // fixext8
			return pos + 10, nil
		case 0xd8: // fixext16
			return pos + 18, nil
		case 0xdc: // array16
			return skipArrayN(b, pos, 2)
		case 0xdd: // array32
			return skipArrayN(b, pos, 4)
		case 0xde: // map16
			return skipMapN(b, pos, 2)
		case 0xdf: // map32
			return skipMapN(b, pos, 4)
		default:
			return 0, fmt.Errorf("msgpack: 未知标记 %#x @%d", m, pos)
		}
	default:
		return 0, fmt.Errorf("msgpack: 未知标记 %#x @%d", m, pos)
	}
}

func readBE(b []byte, n int) (int, error) {
	if len(b) < n {
		return 0, fmt.Errorf("msgpack: 长度字段截断")
	}
	v := 0
	for i := 0; i < n; i++ {
		v = v<<8 | int(b[i])
	}
	return v, nil
}

func skipSized(b []byte, pos, sizeBytes int) (int, error) {
	hdr := 1 + sizeBytes
	n, err := readBE(b[pos+1:], sizeBytes)
	if err != nil {
		return 0, err
	}
	return skipBytes(b, pos+hdr, n)
}

func skipExt(b []byte, pos, sizeBytes int) (int, error) {
	hdr := 1 + sizeBytes
	n, err := readBE(b[pos+1:], sizeBytes)
	if err != nil {
		return 0, err
	}
	// 长度字段后还有 1 字节 ext type
	return skipBytes(b, pos+hdr+1, n)
}

func skipBytes(b []byte, pos, n int) (int, error) {
	if n < 0 || pos+n > len(b) {
		return 0, fmt.Errorf("msgpack: 数据截断 (pos=%d n=%d len=%d)", pos, n, len(b))
	}
	return pos + n, nil
}

func skipArrayBody(b []byte, pos, count int) (int, error) {
	for i := 0; i < count; i++ {
		next, err := skipMsgpackValue(b, pos)
		if err != nil {
			return 0, err
		}
		pos = next
	}
	return pos, nil
}

func skipMapBody(b []byte, pos, pairs int) (int, error) {
	for i := 0; i < pairs; i++ {
		next, err := skipMsgpackValue(b, pos) // key
		if err != nil {
			return 0, err
		}
		pos = next
		next, err = skipMsgpackValue(b, pos) // value
		if err != nil {
			return 0, err
		}
		pos = next
	}
	return pos, nil
}

func skipArrayN(b []byte, pos, sizeBytes int) (int, error) {
	n, err := readBE(b[pos+1:], sizeBytes)
	if err != nil {
		return 0, err
	}
	return skipArrayBody(b, pos+1+sizeBytes, n)
}

func skipMapN(b []byte, pos, sizeBytes int) (int, error) {
	n, err := readBE(b[pos+1:], sizeBytes)
	if err != nil {
		return 0, err
	}
	return skipMapBody(b, pos+1+sizeBytes, n)
}

// readMsgpackString 读取一个字符串键（只接受 str 族；其它类型视为非法键）。
func readMsgpackString(b []byte, pos int) (string, int, error) {
	if pos >= len(b) {
		return "", 0, fmt.Errorf("msgpack: 键越界")
	}
	m := b[pos]
	switch {
	case m >= 0xa0 && m <= 0xbf: // fixstr
		n := int(m & 0x1f)
		end, err := skipBytes(b, pos+1, n)
		if err != nil {
			return "", 0, err
		}
		return string(b[pos+1 : end]), end, nil
	case m == 0xd9 || m == 0xda || m == 0xdb: // str8/16/32
		sizeBytes := map[byte]int{0xd9: 1, 0xda: 2, 0xdb: 4}[m]
		n, err := readBE(b[pos+1:], sizeBytes)
		if err != nil {
			return "", 0, err
		}
		start := pos + 1 + sizeBytes
		end, err := skipBytes(b, start, n)
		if err != nil {
			return "", 0, err
		}
		return string(b[start:end]), end, nil
	default:
		return "", 0, fmt.Errorf("msgpack: map 键不是字符串（标记 %#x）", m)
	}
}

// mapHeader 返回顶层 map 的 (pairs, bodyOffset)。
func mapHeader(b []byte) (int, int, error) {
	if len(b) == 0 {
		return 0, 0, fmt.Errorf("msgpack: 空载荷")
	}
	m := b[0]
	switch {
	case m >= 0x80 && m <= 0x8f:
		return int(m & 0x0f), 1, nil
	case m == 0xde:
		n, err := readBE(b[1:], 2)
		return n, 3, err
	case m == 0xdf:
		n, err := readBE(b[1:], 4)
		return n, 5, err
	default:
		return 0, 0, fmt.Errorf("msgpack: 顶层不是 map（标记 %#x）", m)
	}
}

// StripSignedKeys 生成 sig_version=2 的签名基线：
// 从原始 map 中删除 `signature` 与 `raw_signed_bytes`，**保持其余键值对的原始顺序**。
func StripSignedKeys(raw []byte) ([]byte, error) {
	pairs, off, err := mapHeader(raw)
	if err != nil {
		return nil, err
	}
	type kv struct{ raw []byte }
	kept := make([]kv, 0, pairs)
	pos := off
	for i := 0; i < pairs; i++ {
		pairStart := pos
		key, next, err := readMsgpackString(raw, pos)
		if err != nil {
			return nil, err
		}
		pos = next
		// 值整体原样保留
		valEnd, err := skipMsgpackValue(raw, pos)
		if err != nil {
			return nil, err
		}
		pos = valEnd
		if key == msgpackKeySignature || key == msgpackKeyRawSigned {
			continue
		}
		kept = append(kept, kv{raw: raw[pairStart:valEnd]})
	}
	if pos > len(raw) {
		return nil, fmt.Errorf("msgpack: map 越界")
	}

	// 按剩余对数重新写 map 头，再按原顺序拼接键值对字节
	out := make([]byte, 0, len(raw))
	n := len(kept)
	switch {
	case n <= 15:
		out = append(out, byte(0x80|n))
	case n <= 0xffff:
		out = append(out, 0xde, byte(n>>8), byte(n))
	default:
		out = append(out, 0xdf, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	for _, item := range kept {
		out = append(out, item.raw...)
	}
	return out, nil
}
