package mesh

import (
	"encoding/binary"
	"fmt"
	"net"
	"sync"
)

// 数据面纯逻辑（对齐 MobiHop crates/mobihop-dataplane/src/ip.rs + engine.rs 最小集）。
//
// 本文件只做与平台无关的部分：IP 头解析、虚拟 IP 表（精确映射 + 广播）、
// 帧封装/解封（IP 包 ↔ Frame + Session AEAD）。TUN 读写在 tun_windows.go / tun_linux.go。

// ParseDstAddr 解析 IP 包的目的地址（ip.rs:8-10，IPv4 偏移16 / IPv6 偏移24）。
func ParseDstAddr(packet []byte) (net.IP, error) {
	return addrAt(packet, 16, 24)
}

// ParseSrcAddr 解析 IP 包的源地址（ip.rs:12-15，IPv4 偏移12 / IPv6 偏移8）。
func ParseSrcAddr(packet []byte) (net.IP, error) {
	return addrAt(packet, 12, 8)
}

func addrAt(packet []byte, v4off, v6off int) (net.IP, error) {
	if len(packet) == 0 {
		return nil, fmt.Errorf("mesh ip: 空包")
	}
	switch packet[0] >> 4 {
	case 4:
		ihl := int(packet[0]&0x0f) * 4
		if ihl < 20 || len(packet) < 20 {
			return nil, fmt.Errorf("mesh ip: IPv4 头非法 (ihl=%d, len=%d)", ihl, len(packet))
		}
		total := int(binary.BigEndian.Uint16(packet[2:4]))
		if total < ihl || len(packet) < total {
			return nil, fmt.Errorf("mesh ip: IPv4 total_length 非法 (%d)", total)
		}
		return net.IPv4(packet[v4off], packet[v4off+1], packet[v4off+2], packet[v4off+3]).To4(), nil
	case 6:
		if len(packet) < 40 {
			return nil, fmt.Errorf("mesh ip: IPv6 头截断 (len=%d)", len(packet))
		}
		return append(net.IP(nil), packet[v6off:v6off+16]...), nil
	default:
		return nil, fmt.Errorf("mesh ip: 未知 IP 版本 %d", packet[0]>>4)
	}
}

// VirtualIPTable 是虚拟 IP → NodeID 的映射（最小集：精确匹配 + 广播）。
// 并发安全（数据面读、控制面写）。
type VirtualIPTable struct {
	mu     sync.RWMutex
	byIP   map[string]NodeID // IP 字符串 → NodeID
	selfIP net.IP
	selfID NodeID
}

func NewVirtualIPTable(selfID NodeID, selfIP net.IP) *VirtualIPTable {
	return &VirtualIPTable{
		byIP:   make(map[string]NodeID),
		selfID: selfID,
		selfIP: selfIP,
	}
}

func (t *VirtualIPTable) Add(ip net.IP, id NodeID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.byIP[ip.String()] = id
}

func (t *VirtualIPTable) Remove(ip net.IP) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.byIP, ip.String())
}

// Lookup 查目的 IP 对应的 NodeID；广播/组播返回零 NodeID + broadcast=true。
func (t *VirtualIPTable) Lookup(ip net.IP) (id NodeID, broadcast bool, ok bool) {
	if ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
		return NodeID{}, true, true
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	id, ok = t.byIP[ip.String()]
	return id, false, ok
}

// Encapsulate 把一个 IP 包封装成 Data 帧（E2E AEAD 加密 + 32B 头）。
//
// 流程（对齐 MobiHop 出站链路）：
//
//	dst IP → NodeID（查表）→ 构造 Frame{Type:Data, Flags:ENCRYPTED, TTL:16,
//	Src:self, Dst:target, Counter:session.send_counter()}
//	→ 头编码为 AAD → Session.Encrypt(aad, 整个 IP 包) → 载荷=密文‖tag → Frame.Encode()
//
// wireVersion 省略时用默认 v2；对已知 v1 对端必须传 WireVersionV1 ——
// 因为 version 被纳入 AAD 且旧节点在头部校验处丢 0x02 帧，发错版本必然不通。
func Encapsulate(packet []byte, srcID, dstID NodeID, sess *Session, wireVersion ...byte) ([]byte, error) {
	dst, err := ParseDstAddr(packet)
	if err != nil {
		return nil, err
	}
	_ = dst // 目标已由调用方查表确定（dstID），这里只校验包合法
	counter := sess.SendCounter()
	// AAD 的 payload_len 字段 = 密文长度（含 tag）。加密前先用等长占位，
	// 保证计算 AAD 时的 payload_len 与最终 Encode 的一致（否则认证失败）。
	ciphertextLen := len(packet) + TagLen
	version := WireVersionDefault
	if len(wireVersion) > 0 && wireVersion[0] != 0 {
		version = wireVersion[0]
	}
	f := &Frame{
		Version: version,
		Type:    MsgData,
		Flags:   FlagEncrypted,
		TTL:     DefaultTTL,
		Payload: make([]byte, ciphertextLen), // 占位：仅用于 AAD 的 payload_len
		Src:     srcID,
		Dst:     dstID,
		Counter: counter,
	}
	aad := f.AADBytes() // counter + payload_len 均已确定
	gotCounter, ct, err := sess.Encrypt(aad, packet)
	if err != nil {
		return nil, fmt.Errorf("mesh dataplane: 加密失败: %w", err)
	}
	if gotCounter != counter {
		return nil, fmt.Errorf("mesh dataplane: counter 不一致 %d != %d", gotCounter, counter)
	}
	f.Payload = ct
	return f.Encode()
}

// Decapsulate 把一个 Data 帧解封成 IP 包（验证 dst=self + AEAD + 防重放）。
//
// 流程（对齐 MobiHop 入站）：
//
//	Frame.Encode 的 AAD（归一化头）→ Session.Decrypt(counter, aad, payload) → IP 包
func Decapsulate(frameBytes []byte, selfID NodeID, sess *Session) ([]byte, error) {
	f, err := Decode(frameBytes)
	if err != nil {
		return nil, err
	}
	if f.Type != MsgData {
		return nil, fmt.Errorf("mesh dataplane: 非 Data 帧 (type=%#x)", f.Type)
	}
	if f.Dst != selfID {
		return nil, fmt.Errorf("mesh dataplane: 帧目标非本节点")
	}
	if f.Flags&FlagEncrypted == 0 {
		return nil, fmt.Errorf("mesh dataplane: Data 帧未加密")
	}
	aad := f.AADBytes() // 归一化头（TTL/RELAYED 已抹除）
	pt, err := sess.Decrypt(f.Counter, aad, f.Payload)
	if err != nil {
		return nil, fmt.Errorf("mesh dataplane: 解密失败: %w", err)
	}
	// 校验解出的确实是 IP 包
	if _, err := ParseDstAddr(pt); err != nil {
		return nil, fmt.Errorf("mesh dataplane: 载荷非 IP 包: %w", err)
	}
	return pt, nil
}

// BroadcastFrame 构造广播帧（dst = 全 0xFF），用于首次发现。
func BroadcastFrame(payload []byte, srcID NodeID, ttl byte) ([]byte, error) {
	var dst NodeID
	for i := range dst {
		dst[i] = 0xff
	}
	f := &Frame{Type: MsgData, Flags: 0, TTL: ttl, Payload: payload, Src: srcID, Dst: dst, Counter: 0}
	return f.Encode()
}
