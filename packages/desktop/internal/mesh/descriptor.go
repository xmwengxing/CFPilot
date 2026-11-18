package mesh

import (
	"crypto/ed25519"
	"fmt"
	"net"

	"github.com/vmihailenco/msgpack/v5"
)

// NodeDescriptor 是组网节点描述符（对齐 MobiHop mobihop-routing/src/descriptor.rs）。
//
// 只实现组网必需字段；MobiHop 的其它可选字段（subnet_cidrs / capabilities /
// agent_capabilities / alias / tags / nat_profile 等）用 omitempty 省略，
// 编码后与 MobiHop 的 `skip_serializing_if` 语义一致 ⇒ 双向可解析。
//
// ## 签名基线（H1-4）
//
// - `sig_version == nil / 1`：v1 基线 —— signature 置 64 字节零后做 named MessagePack
//   重编码，Ed25519 覆盖全部字段（descriptor.rs:231-243）。
// - `sig_version >= 2`：**线上原始载荷**去掉 `signature`（与 `raw_signed_bytes`）后
//   按 named 重编码，Ed25519 覆盖剩余字节（descriptor.rs:259）。
//   v2 必须用原始字节：本地结构体重编码会因字段顺序/可选字段差异导致验签失败。
//
// ## loss_rate 量化
//
// 签名前必须把 `loss_rate` 量化到 0.01（`(x*100).round()/100`），
// 否则第 N 位小数会把签名基线抖掉，导致「内容没变却反复重签/验签失败」。
type NodeDescriptor struct {
	NodeID      NodeID          `msgpack:"node_id"`
	IdentityPub PubKey          `msgpack:"identity_pubkey"`
	TunnelPub   PubKey          `msgpack:"tunnel_pubkey"`
	VirtualIPv4 string          `msgpack:"virtual_ipv4,omitempty"`
	Neighbors   []NeighborEntry `msgpack:"neighbors"`
	Seq         uint64          `msgpack:"seq"`
	// SigVersion 省略时与旧描述符逐字节一致（None ⇒ 不出现该键）。
	SigVersion *uint8 `msgpack:"sig_version,omitempty"`
	Signature  []byte `msgpack:"signature,omitempty"`

	// raw 是解码时保留的线上原始载荷（不参与序列化）。
	// v2 验签必须用它；本地新建的描述符没有它，走 v1 重编码基线。
	raw []byte
}

// NeighborEntry 是对端权重声明（descriptor.rs:125-142）。
//
// ⚠️ 新增字段必须在**末尾**（rtt_min_ms / jitter_ms）——这是向后兼容的前提，
// 插到中间会让旧端解码错位。
type NeighborEntry struct {
	NodeID   NodeID  `msgpack:"node_id"`
	RTTMS    uint32  `msgpack:"rtt_ms"`
	LossRate float64 `msgpack:"loss_rate"`
	RTTMinMS *uint32 `msgpack:"rtt_min_ms,omitempty"`
	JitterMS *uint32 `msgpack:"jitter_ms,omitempty"`
}

// QuantizeLoss 把丢包率量化到 0.01（router.rs:123）。
func QuantizeLoss(x float64) float64 {
	if x < 0 {
		x = 0
	}
	if x > 1 {
		x = 1
	}
	// 四舍五入到百分位；用 math.Round 语义
	return float64(int64(x*100+0.5)) / 100
}

// signingBytesV1 生成 v1 签名基线（signature=64 零字节 + named MessagePack）。
func (d *NodeDescriptor) signingBytesV1() ([]byte, error) {
	copyD := *d
	copyD.raw = nil
	copyD.Signature = make([]byte, msgpackSignaturePadding)
	return msgpack.Marshal(&copyD)
}

// signingBytesV2 生成 v2 签名基线：编码时**省略 signature**。
//
// 与验签侧等价：验签从原始载荷删掉 signature 键后按原顺序重编码，
// 而这里编码的正是「除 signature 外的全部字段、按结构体顺序」，
// 收到我们帧的一方删除 signature 后得到同一串字节。
func (d *NodeDescriptor) signingBytesV2() ([]byte, error) {
	copyD := *d
	copyD.raw = nil
	copyD.Signature = nil
	return msgpack.Marshal(&copyD)
}

// Sign 用 Ed25519 身份私钥签名描述符。
//
// CFPilot 作为端点对外发布描述符时使用 **sig_version = 2**（H1-4）：
// 与 MobiHop 当前发版一致，也让邻居质量样本将来扩展时不用再改基线。
func (d *NodeDescriptor) Sign(identitySeed [32]byte) error {
	v := uint8(2)
	d.SigVersion = &v
	bytes, err := d.signingBytesV2()
	if err != nil {
		return err
	}
	priv := ed25519.NewKeyFromSeed(identitySeed[:])
	d.Signature = ed25519.Sign(priv, bytes)
	return nil
}

// Verify 校验描述符签名与 node_id 绑定：
//   - node_id == BLAKE3(identity_pubkey)[0..8]
//   - sig_version>=2 用原始字节基线；否则用 v1 重编码基线
func (d *NodeDescriptor) Verify() error {
	if len(d.Signature) != ed25519.SignatureSize {
		return fmt.Errorf("descriptor: 签名长度非法 %d", len(d.Signature))
	}
	expect := NodeIDFromIdentityPub(d.IdentityPub[:])
	if d.NodeID != expect {
		return fmt.Errorf("descriptor: node_id 与 identity_pubkey 不符")
	}

	var signed []byte
	var err error
	if d.SigVersion != nil && *d.SigVersion >= 2 {
		if len(d.raw) > 0 {
			// 收到别人发的描述符：必须从原始载荷删键重编码（保留原 map 顺序与未知字段）
			signed, err = StripSignedKeys(d.raw)
		} else {
			// 本地刚签完还没经过线上编码：按同一口径重算
			signed, err = d.signingBytesV2()
		}
	} else {
		signed, err = d.signingBytesV1()
	}
	if err != nil {
		return err
	}
	if !ed25519.Verify(d.IdentityPub[:], signed, d.Signature) {
		return fmt.Errorf("descriptor: 签名验证失败")
	}
	return nil
}

// Encode 编码描述符为 named MessagePack（wire 兼容 MobiHop）。
func (d *NodeDescriptor) Encode() ([]byte, error) { return msgpack.Marshal(d) }

// DecodeDescriptor 解码描述符，并保留原始载荷供 v2 验签。
func DecodeDescriptor(b []byte) (*NodeDescriptor, error) {
	var d NodeDescriptor
	if err := msgpack.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	d.raw = append([]byte(nil), b...)
	return &d, nil
}

// GossipMessage 是 Gossip 帧载荷（gossip.rs:24-28）：一批描述符。
type GossipMessage struct {
	Descriptors []NodeDescriptor `msgpack:"descriptors"`
}

func (g *GossipMessage) Encode() ([]byte, error) { return msgpack.Marshal(g) }

// DecodeGossip 解码 Gossip 消息。
//
// ⚠️ 不能直接 `Unmarshal` 到 []NodeDescriptor：那样会丢掉每个描述符的**原始字节**，
// 而 sig_version>=2 的验签必须基于原始字节（见 NodeDescriptor 注释）。
// 这里先解出每条描述符的 RawMessage，再逐条解码并挂上 raw。
func DecodeGossip(b []byte) (*GossipMessage, error) {
	var raw struct {
		Descriptors []msgpack.RawMessage `msgpack:"descriptors"`
	}
	if err := msgpack.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	msg := &GossipMessage{Descriptors: make([]NodeDescriptor, 0, len(raw.Descriptors))}
	for _, item := range raw.Descriptors {
		var d NodeDescriptor
		if err := msgpack.Unmarshal(item, &d); err != nil {
			return nil, err
		}
		d.raw = append([]byte(nil), item...)
		msg.Descriptors = append(msg.Descriptors, d)
	}
	return msg, nil
}

// VirtualIP 返回虚拟 IPv4（字符串 → net.IP）。
func (d *NodeDescriptor) VirtualIP() net.IP {
	if d.VirtualIPv4 == "" {
		return nil
	}
	return net.ParseIP(d.VirtualIPv4)
}
