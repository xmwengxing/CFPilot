package mesh

import (
	"crypto/ed25519"
	"fmt"
	"net"

	"github.com/vmihailenco/msgpack/v5"
)

// NodeDescriptor 是组网节点描述符（对齐 MobiHop mobihop-routing/src/descriptor.rs:134-203）。
//
// 只实现组网必需字段；MobiHop 的其它可选字段（subnet_cidrs / capabilities /
// agent_capabilities / alias / tags / nat_profile / sig_version 等）用 omitempty 省略，
// 编码后与 MobiHop 的 `skip_serializing_if` 语义一致 ⇒ 双向可解析。
//
// 签名基线 v1（descriptor.rs:231-243）：signature 置 64 字节零后做 MessagePack named
// 编码，Ed25519 私钥签名覆盖全部字段。
type NodeDescriptor struct {
	NodeID      NodeID          `msgpack:"node_id"`
	IdentityPub PubKey          `msgpack:"identity_pubkey"`
	TunnelPub   PubKey          `msgpack:"tunnel_pubkey"`
	VirtualIPv4 string          `msgpack:"virtual_ipv4,omitempty"`
	Neighbors   []NeighborEntry `msgpack:"neighbors"`
	Seq         uint64          `msgpack:"seq"`
	Signature   []byte          `msgpack:"signature"`
}

// NeighborEntry 是对端权重声明（descriptor.rs:124-132）。
type NeighborEntry struct {
	NodeID   NodeID  `msgpack:"node_id"`
	RTTMS    uint32  `msgpack:"rtt_ms"`
	LossRate float64 `msgpack:"loss_rate"`
}

// signingBytes 生成签名基线（signature=64 零字节 + named MessagePack）。
func (d *NodeDescriptor) signingBytes() ([]byte, error) {
	copyD := *d
	copyD.Signature = make([]byte, 64)
	return msgpack.Marshal(&copyD)
}

// Sign 用 Ed25519 身份私钥签名描述符（覆盖全字段）。
func (d *NodeDescriptor) Sign(identitySeed [32]byte) error {
	d.Signature = make([]byte, 64)
	bytes, err := d.signingBytes()
	if err != nil {
		return err
	}
	priv := ed25519.NewKeyFromSeed(identitySeed[:])
	d.Signature = ed25519.Sign(priv, bytes)
	return nil
}

// Verify 校验描述符签名与 node_id 绑定：
//   - node_id == BLAKE3(identity_pubkey)[0..8]
//   - 签名覆盖全字段且由 identity_pubkey 验证
func (d *NodeDescriptor) Verify() error {
	if len(d.Signature) != ed25519.SignatureSize {
		return fmt.Errorf("descriptor: 签名长度非法 %d", len(d.Signature))
	}
	expect := NodeIDFromIdentityPub(d.IdentityPub[:])
	if d.NodeID != expect {
		return fmt.Errorf("descriptor: node_id 与 identity_pubkey 不符")
	}
	bytes, err := d.signingBytes()
	if err != nil {
		return err
	}
	if !ed25519.Verify(d.IdentityPub[:], bytes, d.Signature) {
		return fmt.Errorf("descriptor: 签名验证失败")
	}
	return nil
}

// Encode 编码描述符为 named MessagePack（wire 兼容 MobiHop）。
func (d *NodeDescriptor) Encode() ([]byte, error) { return msgpack.Marshal(d) }

// DecodeDescriptor 解码描述符。
func DecodeDescriptor(b []byte) (*NodeDescriptor, error) {
	var d NodeDescriptor
	if err := msgpack.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// GossipMessage 是 Gossip 帧载荷（gossip.rs:24-28）：一批描述符。
type GossipMessage struct {
	Descriptors []NodeDescriptor `msgpack:"descriptors"`
}

func (g *GossipMessage) Encode() ([]byte, error) { return msgpack.Marshal(g) }
func DecodeGossip(b []byte) (*GossipMessage, error) {
	var g GossipMessage
	if err := msgpack.Unmarshal(b, &g); err != nil {
		return nil, err
	}
	return &g, nil
}

// VirtualIP 返回虚拟 IPv4（字符串 → net.IP）。
func (d *NodeDescriptor) VirtualIP() net.IP {
	if d.VirtualIPv4 == "" {
		return nil
	}
	return net.ParseIP(d.VirtualIPv4)
}
