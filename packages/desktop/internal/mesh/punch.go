package mesh

import (
	"fmt"

	"github.com/vmihailenco/msgpack/v5"
)

// 打洞控制消息（契约 §4，control.rs:69-215）。
//
// 编码总则（契约 §4.1）：
//   - rmp-serde to_vec_named ⇒ 结构体编码为 map，字段名作 key（不依赖字段顺序）
//   - 枚举变体为 serde 外部标签：单键 map，键名 = 变体名
//   - NodeId = 8 个整数的 MessagePack array（newtype 透明）
//   - CandidateAddr: "V4" → {ip:[4]u8, port:u16}, "V6" → {ip:[16]u8, port:u16}
//   - PunchAck.observed: Option，缺省时键不出现
//
// msgpack/v5 的结构体默认编码为 map（字段名作 key），与 to_vec_named 一致。
// 枚举用自定义 MarshalMsgpack/UnmarshalMsgpack 实现外部标签。

// NodeID 是 8 字节节点 ID（wire 为 8 个整数的 array）。
type NodeID [8]byte

// MarshalMsgpack 把 NodeID 编码为 8 元素整数 array（契约 §4.4）。
//
// ⚠️ 必须用 [8]uint8 而非 []byte：msgpack/v5 对 []byte 走 bin8 编码（0xc4），
// 而 Rust serde 的 `NodeId(pub [u8;8])` newtype 透明编码为 fixarray（0x98 + 8 字节）。
// 两者 wire 不同，必须用定长数组类型强制走 array 编码。
func (n NodeID) MarshalMsgpack() ([]byte, error) {
	// 用 [8]int 中转：msgpack/v5 对任何 uint8 数组/切片都走 bin8（0xc4），
	// 而 int 数组走 fixarray（0x98 + 单字节 fixint），与 Rust serde [u8;8] 一致。
	arr := [8]int{int(n[0]), int(n[1]), int(n[2]), int(n[3]), int(n[4]), int(n[5]), int(n[6]), int(n[7])}
	return msgpack.Marshal(arr)
}

// UnmarshalMsgpack 从 8 元素 array 解码 NodeID。
func (n *NodeID) UnmarshalMsgpack(b []byte) error {
	var arr [8]int
	if err := msgpack.Unmarshal(b, &arr); err != nil {
		return err
	}
	for i, v := range arr {
		n[i] = byte(v)
	}
	return nil
}

// CandidateKind 对应控制.rs:133-141。
type CandidateKind string

const (
	CandidateHost            CandidateKind = "Host"
	CandidateServerReflexive CandidateKind = "ServerReflexive"
	CandidateRelayed         CandidateKind = "Relayed"
)

// CandidateAddr 是候选地址枚举（契约 §4.1，control.rs:69-75）。
// wire: {"V4":{"ip":[...4],"port":n}} 或 {"V6":{"ip":[...16],"port":n}}
type CandidateAddr struct {
	V4 *V4Addr `msgpack:"V4,omitempty"`
	V6 *V6Addr `msgpack:"V6,omitempty"`
}

type V4Addr struct {
	IP   [4]byte
	Port uint16
}

// EncodeMsgpack 编码为 named map {"ip": [4]ints, "port": n}（契约 §4.1）。
func (a V4Addr) EncodeMsgpack(enc *msgpack.Encoder) error {
	enc.EncodeMapLen(2)
	enc.EncodeString("ip")
	enc.EncodeArrayLen(4)
	for _, b := range a.IP {
		enc.EncodeInt(int64(b))
	}
	enc.EncodeString("port")
	enc.EncodeUint16(a.Port)
	return nil
}

func (a *V4Addr) DecodeMsgpack(dec *msgpack.Decoder) error {
	n, err := dec.DecodeMapLen()
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		key, err := dec.DecodeString()
		if err != nil {
			return err
		}
		switch key {
		case "ip":
			l, err := dec.DecodeArrayLen()
			if err != nil {
				return err
			}
			if l != 4 {
				return fmt.Errorf("mesh punch: V4 ip 长度 %d != 4", l)
			}
			for j := 0; j < 4; j++ {
				v, err := dec.DecodeInt()
				if err != nil {
					return err
				}
				a.IP[j] = byte(v)
			}
		case "port":
			v, err := dec.DecodeUint16()
			if err != nil {
				return err
			}
			a.Port = v
		default:
			if err := dec.Skip(); err != nil {
				return err
			}
		}
	}
	return nil
}

type V6Addr struct {
	IP   [16]byte
	Port uint16
}

func (a V6Addr) EncodeMsgpack(enc *msgpack.Encoder) error {
	enc.EncodeMapLen(2)
	enc.EncodeString("ip")
	enc.EncodeArrayLen(16)
	for _, b := range a.IP {
		enc.EncodeInt(int64(b))
	}
	enc.EncodeString("port")
	enc.EncodeUint16(a.Port)
	return nil
}

func (a *V6Addr) DecodeMsgpack(dec *msgpack.Decoder) error {
	n, err := dec.DecodeMapLen()
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		key, err := dec.DecodeString()
		if err != nil {
			return err
		}
		switch key {
		case "ip":
			l, err := dec.DecodeArrayLen()
			if err != nil {
				return err
			}
			if l != 16 {
				return fmt.Errorf("mesh punch: V6 ip 长度 %d != 16", l)
			}
			for j := 0; j < 16; j++ {
				v, err := dec.DecodeInt()
				if err != nil {
					return err
				}
				a.IP[j] = byte(v)
			}
		case "port":
			v, err := dec.DecodeUint16()
			if err != nil {
				return err
			}
			a.Port = v
		default:
			if err := dec.Skip(); err != nil {
				return err
			}
		}
	}
	return nil
}

func NewV4Addr(ip [4]byte, port uint16) CandidateAddr {
	return CandidateAddr{V4: &V4Addr{IP: ip, Port: port}}
}

func NewV6Addr(ip [16]byte, port uint16) CandidateAddr {
	return CandidateAddr{V6: &V6Addr{IP: ip, Port: port}}
}

// Candidate 是打洞候选（契约 §4.3，control.rs:146-170）。
type Candidate struct {
	Addr     CandidateAddr `msgpack:"addr"`
	Kind     CandidateKind `msgpack:"kind"`
	Priority uint64        `msgpack:"priority"`
}

// PriorityFor 计算候选基础优先级（契约 §4.3）。
func PriorityFor(kind CandidateKind, ipv6 bool) uint64 {
	var p uint64
	switch kind {
	case CandidateHost:
		p = PriorityHost
	case CandidateServerReflexive:
		p = PriorityServerReflexive
	case CandidateRelayed:
		p = PriorityRelayed
	default:
		p = 0
	}
	if ipv6 && p > 0 {
		p += PriorityIPv6Bonus
	}
	return p
}

// PunchMessage 是 0x05 HolePunch 帧的控制面载荷（契约 §4.4，control.rs:177-215）。
// 枚举外部标签：单键 map，值为内部字段 map。
type PunchMessage struct {
	StunQuery  *StunQueryMsg    `msgpack:"StunQuery,omitempty"`
	StunResp   *StunResponseMsg `msgpack:"StunResponse,omitempty"`
	PunchReq   *PunchRequest    `msgpack:"PunchRequest,omitempty"`
	PunchReply *PunchReply      `msgpack:"PunchReply,omitempty"`
	PunchAck   *PunchAck        `msgpack:"PunchAck,omitempty"`
	PunchProbe *PunchProbe      `msgpack:"PunchProbe,omitempty"`
}

type StunQueryMsg struct {
	Nonce uint64 `msgpack:"nonce"`
}

type StunResponseMsg struct {
	Nonce     uint64        `msgpack:"nonce"`
	Reflexive CandidateAddr `msgpack:"reflexive"`
}

type PunchRequest struct {
	From       NodeID      `msgpack:"from"`
	Candidates []Candidate `msgpack:"candidates"`
	PunchAtMS  uint64      `msgpack:"punch_at_ms"`
	Nonce      uint64      `msgpack:"nonce"`
}

type PunchReply struct {
	From       NodeID      `msgpack:"from"`
	Candidates []Candidate `msgpack:"candidates"`
	Nonce      uint64      `msgpack:"nonce"`
}

type PunchAck struct {
	From     NodeID         `msgpack:"from"`
	Nonce    uint64         `msgpack:"nonce"`
	Observed *CandidateAddr `msgpack:"observed,omitempty"` // Option：nil 时键不出现
}

type PunchProbe struct {
	From  NodeID `msgpack:"from"`
	Nonce uint64 `msgpack:"nonce"`
}

// EncodePunchMessage 序列化打洞消息（named MessagePack）。
func EncodePunchMessage(m *PunchMessage) ([]byte, error) {
	b, err := msgpack.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("mesh punch: 编码失败: %w", err)
	}
	return b, nil
}

// DecodePunchMessage 反序列化打洞消息。
func DecodePunchMessage(b []byte) (*PunchMessage, error) {
	var m PunchMessage
	if err := msgpack.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("mesh punch: 解码失败: %w", err)
	}
	return &m, nil
}

// RelayMessage 是 0x06 RelayMgmt 帧的控制面载荷（契约 §4.6，control.rs:276-323）。
// 这里只定义字段最复杂的 Register/AuthAccept/Heartbeat/Stats，其余变体留作扩展。
type RelayMessage struct {
	Register   *RelayRegister   `msgpack:"Register,omitempty"`
	AuthAccept *RelayAuthAccept `msgpack:"AuthAccept,omitempty"`
	AuthReject *RelayAuthReject `msgpack:"AuthReject,omitempty"`
	Heartbeat  *RelayHeartbeat  `msgpack:"Heartbeat,omitempty"`
	Stats      *RelayStatsMsg   `msgpack:"Stats,omitempty"`
	Disconnect *RelayDisconnect `msgpack:"Disconnect,omitempty"`
}

// RelayAuthReject 是中继拒绝注册 / 回收会话的回包。
//
// `Reason` 用 `any` 接收：Rust 侧是 `RelayReason` 枚举（serde 外部标签），
// 未来新增变体也不应让整帧解码失败（那会把「被拒」误当成「无关帧」）。
type RelayAuthReject struct {
	NodeID NodeID `msgpack:"node_id"`
	Reason any    `msgpack:"reason"`
}

// MsgpackByteArray 是「Rust `Vec<u8>` / `[u8; N]` 兼容」的字节串。
//
// ⚠️ msgpack/v5 对 `[]byte` 默认走 **bin8（0xc4）**，而 Rust 侧 rmp-serde 把
// `Vec<u8>` / `[u8;8]` 编成**整数 array**（0x90…）。两者 wire 不同，中继端反序列化
// 直接失败并静默丢帧——症状是“节点日志说已注册、中继侧恒 rooms=0”。
// 这里显式按整数 array 编码（与 punch.go 里 NodeID 的处理同因同法）。
type MsgpackByteArray []byte

func (b MsgpackByteArray) MarshalMsgpack() ([]byte, error) {
	arr := make([]int, len(b))
	for i, v := range b {
		arr[i] = int(v)
	}
	return msgpack.Marshal(arr)
}

func (b *MsgpackByteArray) UnmarshalMsgpack(raw []byte) error {
	var arr []int
	if err := msgpack.Unmarshal(raw, &arr); err != nil {
		return err
	}
	out := make([]byte, len(arr))
	for i, v := range arr {
		out[i] = byte(v)
	}
	*b = out
	return nil
}

type RelayRegister struct {
	NodeID        NodeID            `msgpack:"node_id"`
	TokenHash     MsgpackByteArray  `msgpack:"token_hash"`
	RequestedKbps uint32            `msgpack:"requested_kbps"`
	RoomTag       *MsgpackByteArray `msgpack:"room_tag,omitempty"` // None 时键不出现
}

type RelayAuthAccept struct {
	NodeID              NodeID `msgpack:"node_id"`
	SessionID           uint64 `msgpack:"session_id"`
	HeartbeatIntervalMS uint32 `msgpack:"heartbeat_interval_ms"`
}

type RelayHeartbeat struct {
	NodeID   NodeID `msgpack:"node_id"`
	Seq      uint64 `msgpack:"seq"`
	SentAtMS uint64 `msgpack:"sent_at_ms"`
}

type RelayStats struct {
	TxBytes   uint64 `msgpack:"tx_bytes"`
	TxPackets uint64 `msgpack:"tx_packets"`
	RxBytes   uint64 `msgpack:"rx_bytes"`
	RxPackets uint64 `msgpack:"rx_packets"`
}

type RelayStatsMsg struct {
	NodeID NodeID     `msgpack:"node_id"`
	Stats  RelayStats `msgpack:"stats"`
}

type RelayDisconnect struct {
	NodeID NodeID `msgpack:"node_id"`
	Reason string `msgpack:"reason"`
}

// EncodeRelayMessage / DecodeRelayMessage 序列化中继管理消息。
func EncodeRelayMessage(m *RelayMessage) ([]byte, error) {
	return msgpack.Marshal(m)
}

func DecodeRelayMessage(b []byte) (*RelayMessage, error) {
	var m RelayMessage
	if err := msgpack.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("mesh relay: 解码失败: %w", err)
	}
	return &m, nil
}
