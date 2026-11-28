package mesh

// 握手载荷封装（W4，对齐 MobiHop `mobihop-proto/src/control.rs` 的 `HandshakeMsg`）。
//
// MobiHop 的 0x01 Handshake 载荷是 **MessagePack**（rmp-serde 的 named enum）：
//
//	Init        { noise: Vec<u8> }
//	Reply       { noise: Vec<u8> }
//	KeyMaterial { wire: Vec<u8> }
//	Reply2      { key_confirm: [u8; 32] }   // H2-2（ADR-0016）
//
// 编码形态（rmp-serde 的既定写法，不是自由发挥）：
//   - enum ⇒ 单键 map：0x81 + fixstr 变体名 + 内层；
//   - 结构体 ⇒ 单键 map：0x81 + fixstr 字段名 + 值；
//   - `Vec<u8>` ⇒ **uint 数组**（serde 对 Vec<u8> 走 seq，不是 bin）；
//   - `[u8; 32]` ⇒ 长度 32 的 uint 数组。
//
// 本仓历史上直接发裸 Noise 字节，对端 `decode_msg::<HandshakeMsg>` 必然失败、
// 计 handshake_parse_failed 后丢帧 —— **跨语言握手从未真正建立过**（本地
// CFPilot ↔ CFPilot 因为两边同样裸发才一直「能用」）。现在发送侧默认用
// msgpack，接收侧同时接受两种形态，并按「对端发来什么就回什么」协商：
// 已经跑通的本地组网不受影响，而对端若是 MobiHop 才有机会握上。

// hsMessageKind 是握手变体名（与 MobiHop 的枚举变体同名，大小写敏感）。
type hsMessageKind string

const (
	hsKindInit        hsMessageKind = "Init"
	hsKindReply       hsMessageKind = "Reply"
	hsKindKeyMaterial hsMessageKind = "KeyMaterial"
	hsKindReply2      hsMessageKind = "Reply2"
)

// hsMessage 是一条握手消息。Body 只对 Init/Reply（Noise bytes）与
// KeyMaterial（传输态密文）有意义；Confirm 只对 Reply2 有意义。
type hsMessage struct {
	Kind    hsMessageKind
	Body    []byte
	Confirm [32]byte
}

// MessagePack 类型标记（只列本文件用到的）。
const (
	mpFixMap  = 0x80
	mpFixArr  = 0x90
	mpFixStr  = 0xa0
	mpBin8    = 0xc4
	mpBin16   = 0xc5
	mpBin32   = 0xc6
	mpUint8   = 0xcc
	mpUint16  = 0xcd
	mpUint32  = 0xce
	mpUint64  = 0xcf
	mpStr8    = 0xd9
	mpStr16   = 0xda
	mpStr32   = 0xdb
	mpArray16 = 0xdc
	mpArray32 = 0xdd
	mpMap16   = 0xde
	mpMap32   = 0xdf
)

// encodeHandshakeMsg 把一条握手消息编码为 MessagePack（rmp-serde 等价形态）。
func encodeHandshakeMsg(m hsMessage) []byte {
	b := make([]byte, 0, 128)
	b = append(b, mpFixMap|1)
	b = appendMPStr(b, string(m.Kind))
	b = append(b, mpFixMap|1)
	if m.Kind == hsKindReply2 {
		b = appendMPStr(b, "key_confirm")
		b = appendMPUintArray(b, m.Confirm[:])
		return b
	}
	field := "noise"
	if m.Kind == hsKindKeyMaterial {
		field = "wire"
	}
	b = appendMPStr(b, field)
	b = appendMPUintArray(b, m.Body)
	return b
}

// decodeHandshakeMsg 解析 MessagePack 形态的握手载荷。
// 返回 false 表示「这不是一条 msgpack 握手消息」（调用方应尝试裸 Noise 兼容路径）。
func decodeHandshakeMsg(payload []byte) (hsMessage, bool) {
	r := mpReader{b: payload}
	n, ok := r.mapLen()
	if !ok || n != 1 {
		return hsMessage{}, false
	}
	kind, ok := r.mpStr()
	if !ok {
		return hsMessage{}, false
	}
	m := hsMessage{Kind: hsMessageKind(kind)}
	n, ok = r.mapLen()
	if !ok || n != 1 {
		return hsMessage{}, false
	}
	field, ok := r.mpStr()
	if !ok {
		return hsMessage{}, false
	}
	switch m.Kind {
	case hsKindInit, hsKindReply:
		if field != "noise" {
			return hsMessage{}, false
		}
	case hsKindKeyMaterial:
		if field != "wire" {
			return hsMessage{}, false
		}
	case hsKindReply2:
		if field != "key_confirm" {
			return hsMessage{}, false
		}
	default:
		return hsMessage{}, false
	}
	buf, ok := r.mpBytes()
	if !ok || len(buf) == 0 {
		return hsMessage{}, false
	}
	if r.i != len(r.b) {
		return hsMessage{}, false // 尾部多余字节：不是我们认识的封装
	}
	if m.Kind == hsKindReply2 {
		if len(buf) != 32 {
			return hsMessage{}, false
		}
		copy(m.Confirm[:], buf)
		return m, true
	}
	m.Body = buf
	return m, true
}

func appendMPStr(b []byte, s string) []byte {
	n := len(s)
	switch {
	case n <= 31:
		b = append(b, byte(mpFixStr|n))
	case n <= 0xff:
		b = append(b, mpStr8, byte(n))
	case n <= 0xffff:
		b = append(b, mpStr16, byte(n>>8), byte(n))
	default:
		b = append(b, mpStr32, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	return append(b, s...)
}

// appendMPUintArray 写「uint 数组」：rmp-serde 对 Vec<u8> / [u8; N] 的形态。
// 单字节写成 positive fixint（0x00..0x7f），其余写 uint8（0xcc）。
func appendMPUintArray(b []byte, data []byte) []byte {
	n := len(data)
	switch {
	case n <= 15:
		b = append(b, byte(mpFixArr|n))
	case n <= 0xffff:
		b = append(b, mpArray16, byte(n>>8), byte(n))
	default:
		b = append(b, mpArray32, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	for _, v := range data {
		if v <= 0x7f {
			b = append(b, v)
		} else {
			b = append(b, mpUint8, v)
		}
	}
	return b
}

// mpReader 是只读的最小 MessagePack 解析器（带边界检查，永不 panic）。
type mpReader struct {
	b []byte
	i int
}

func (r *mpReader) byteAt() (byte, bool) {
	if r.i >= len(r.b) {
		return 0, false
	}
	v := r.b[r.i]
	r.i++
	return v, true
}

func (r *mpReader) take(n int) ([]byte, bool) {
	if n < 0 || r.i+n > len(r.b) {
		return nil, false
	}
	v := r.b[r.i : r.i+n]
	r.i += n
	return v, true
}

func (r *mpReader) uintN(n int) (uint64, bool) {
	buf, ok := r.take(n)
	if !ok {
		return 0, false
	}
	var v uint64
	for _, c := range buf {
		v = v<<8 | uint64(c)
	}
	return v, true
}

// mpUint 读一个非负整数（positive fixint / uint8 / uint16 / uint32 / uint64）。
func (r *mpReader) mpUint() (uint64, bool) {
	c, ok := r.byteAt()
	if !ok {
		return 0, false
	}
	switch {
	case c <= 0x7f:
		return uint64(c), true
	case c == mpUint8:
		return r.uintN(1)
	case c == mpUint16:
		return r.uintN(2)
	case c == mpUint32:
		return r.uintN(4)
	case c == mpUint64:
		return r.uintN(8)
	default:
		return 0, false
	}
}

func (r *mpReader) mapLen() (int, bool) {
	c, ok := r.byteAt()
	if !ok {
		return 0, false
	}
	switch {
	case c&0xf0 == mpFixMap:
		return int(c & 0x0f), true
	case c == mpMap16:
		v, ok := r.uintN(2)
		return int(v), ok
	case c == mpMap32:
		v, ok := r.uintN(4)
		return int(v), ok
	default:
		return 0, false
	}
}

func (r *mpReader) mpStr() (string, bool) {
	c, ok := r.byteAt()
	if !ok {
		return "", false
	}
	var n int
	switch {
	case c&0xe0 == mpFixStr:
		n = int(c & 0x1f)
	case c == mpStr8:
		v, ok := r.uintN(1)
		if !ok {
			return "", false
		}
		n = int(v)
	case c == mpStr16:
		v, ok := r.uintN(2)
		if !ok {
			return "", false
		}
		n = int(v)
	case c == mpStr32:
		v, ok := r.uintN(4)
		if !ok {
			return "", false
		}
		n = int(v)
	default:
		return "", false
	}
	buf, ok := r.take(n)
	if !ok {
		return "", false
	}
	return string(buf), true
}

// mpBytes 读字节串。同时接受 rmp-serde 的 uint 数组形态与 msgpack 原生 bin ——
// 前者才是 MobiHop 真正发出来的，后者是为了对将来的 `serde_bytes` 留出余地。
func (r *mpReader) mpBytes() ([]byte, bool) {
	c, ok := r.byteAt()
	if !ok {
		return nil, false
	}
	switch {
	case c == mpBin8:
		v, ok := r.uintN(1)
		if !ok {
			return nil, false
		}
		return r.take(int(v))
	case c == mpBin16:
		v, ok := r.uintN(2)
		if !ok {
			return nil, false
		}
		return r.take(int(v))
	case c == mpBin32:
		v, ok := r.uintN(4)
		if !ok {
			return nil, false
		}
		return r.take(int(v))
	}
	var n int
	switch {
	case c&0xf0 == mpFixArr:
		n = int(c & 0x0f)
	case c == mpArray16:
		v, ok := r.uintN(2)
		if !ok {
			return nil, false
		}
		n = int(v)
	case c == mpArray32:
		v, ok := r.uintN(4)
		if !ok {
			return nil, false
		}
		n = int(v)
	default:
		return nil, false
	}
	if n < 0 || n > len(r.b)-r.i {
		return nil, false
	}
	out := make([]byte, 0, n)
	for k := 0; k < n; k++ {
		v, ok := r.mpUint()
		if !ok || v > 0xff {
			return nil, false
		}
		out = append(out, byte(v))
	}
	return out, true
}
