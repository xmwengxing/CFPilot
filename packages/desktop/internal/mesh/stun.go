package mesh

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// STUN 客户端（RFC 5389 Binding + XOR-MAPPED-ADDRESS）。
//
// ## 对齐与边界
//
// 对齐 MobiHop `crates/mobihop-transport/src/stun.rs` 的**最小可用子集**：
//   - 同一个 UdpHub socket 发出 Binding Request（⚠️ 必须复用监听 socket，
//     另开 socket 会拿到不同的 NAT 映射，后续打洞端口就对不上）；
//   - 解析 XOR-MAPPED-ADDRESS（回退 MAPPED-ADDRESS）；
//   - 多服务器并发探测，按「映射是否一致」保守判定 NAT 形态：
//     全部一致           → 锥形（保守按 NAT3，未做 CHANGE-REQUEST 细分）
//     同 IP 不同端口     → NAT4（对称）
//     不同 IP 的映射     → NAT4（地址相关映射）
//     无有效应答         → Unknown
//
// 未实现（如实标注，避免假装完整）：CHANGE-REQUEST 的 NAT1/NAT2 细分、
// OTHER-ADDRESS、以及 Public（无 NAT）判定 —— 后者需要知道本机公网出口地址，
// 单靠 STUN 映射无法可靠区分「无 NAT」与「端口保持型锥形」。
const (
	stunMagicCookie     uint32 = 0x2112A442
	stunBindingRequest  uint16 = 0x0001
	stunBindingResponse uint16 = 0x0101
	stunAttrMapped      uint16 = 0x0001
	stunAttrXorMapped   uint16 = 0x0020
	stunHeaderLen              = 20
	stunFamilyIPv4      byte   = 0x01
	stunFamilyIPv6      byte   = 0x02
	DefaultStunProbeMS         = 1500
	MinStunProbeMS             = 100
	MaxStunProbeMS             = 30000
)

// DefaultStunServers 对齐 MobiHop 的默认公共池（四家不同运营商，覆盖国内外）。
var DefaultStunServers = []string{
	"stun.cloudflare.com:3478",
	"stun.l.google.com:19302",
	"stun.miwifi.com:3478",
	"stun.qq.com:3478",
}

// StunMapping 是一次成功探测的结果（服务器看到的「我们的公网 IP:端口」）。
type StunMapping struct {
	Server  string
	Address string // ip:port
	IP      string
	Port    int
}

// NatAssessment 是 NAT 判定结果（供状态面板展示）。
type NatAssessment struct {
	// Type：Unknown / NAT3（锥形，保守）/ NAT4（对称）/ Public（v6 无 NAT）
	Type string `json:"type"`
	// Reflexive 是某一致映射（ip:port），仅当探测成功时存在。
	Reflexive string `json:"reflexive,omitempty"`
	// Reflexive6 是 IPv6 侧的反射地址（无 NAT 时即本机全球地址）。
	// IPv6 轮探测到它就足以作为免映射直连候选，无需端口映射。
	Reflexive6 string `json:"reflexive6,omitempty"`
	// Observations 是各服务器的原始观测（诊断用）。
	Observations []StunMapping `json:"observations,omitempty"`
}

// looksLikeSTUN 判断一个 UDP 数据包是否是 STUN 报文（magic cookie 校验）。
func looksLikeSTUN(b []byte) bool {
	if len(b) < stunHeaderLen {
		return false
	}
	return binary.BigEndian.Uint32(b[4:8]) == stunMagicCookie
}

// buildBindingRequest 生成一条无属性的 Binding Request。
func buildBindingRequest(txid [12]byte) []byte {
	buf := make([]byte, stunHeaderLen)
	binary.BigEndian.PutUint16(buf[0:2], stunBindingRequest)
	binary.BigEndian.PutUint16(buf[2:4], 0) // 无属性
	binary.BigEndian.PutUint32(buf[4:8], stunMagicCookie)
	copy(buf[8:20], txid[:])
	return buf
}

// parseBindingResponse 解析 Binding Success Response，提取映射地址。
//
// txid 是本次请求的事务 ID：XOR-MAPPED-ADDRESS 的 IPv6 地址要与
// `magic cookie || txid` 逐字节异或，不传进来就还原不出真实地址（旧实现
// 只处理了 IPv4，IPv6 会直接拿到被异或过的值）。
func parseBindingResponse(b []byte, txid [12]byte) (addr string, port int, err error) {
	if len(b) < stunHeaderLen {
		return "", 0, fmt.Errorf("stun: 报文过短")
	}
	if binary.BigEndian.Uint32(b[4:8]) != stunMagicCookie {
		return "", 0, fmt.Errorf("stun: magic cookie 不符")
	}
	if binary.BigEndian.Uint16(b[0:2]) != stunBindingResponse {
		return "", 0, fmt.Errorf("stun: 非 Binding Success Response")
	}
	msgLen := int(binary.BigEndian.Uint16(b[2:4]))
	if stunHeaderLen+msgLen > len(b) {
		return "", 0, fmt.Errorf("stun: 声明长度超出报文")
	}
	var mapped, xorMapped string
	var mappedPort, xorPort int
	for off := stunHeaderLen; off+4 <= stunHeaderLen+msgLen; {
		typ := binary.BigEndian.Uint16(b[off : off+2])
		alen := int(binary.BigEndian.Uint16(b[off+2 : off+4]))
		valStart := off + 4
		if valStart+alen > len(b) {
			return "", 0, fmt.Errorf("stun: 属性越界")
		}
		val := b[valStart : valStart+alen]
		switch typ {
		case stunAttrXorMapped:
			xorMapped, xorPort, _ = parseAddressAttr(val, true, txid)
		case stunAttrMapped:
			mapped, mappedPort, _ = parseAddressAttr(val, false, txid)
		}
		// 属性按 4 字节对齐
		off = valStart + alen
		if pad := alen % 4; pad != 0 {
			off += 4 - pad
		}
	}
	if xorMapped != "" {
		return xorMapped, xorPort, nil
	}
	if mapped != "" {
		return mapped, mappedPort, nil
	}
	return "", 0, fmt.Errorf("stun: 无 MAPPED/XOR-MAPPED 属性")
}

// parseAddressAttr 解析 MAPPED-ADDRESS / XOR-MAPPED-ADDRESS 属性体。
//
// ⚠️ 属性体布局（RFC 5389 §15.1/§15.2）是：
//
//	[0]    保留（恒 0）
//	[1]    地址族（0x01 = IPv4，0x02 = IPv6）
//	[2:4]  端口（大端）
//	[4:]   地址
//
// 旧实现把 `val[0]` 当地址族、`val[1:3]` 当端口，于是每一个真实 STUN 响应都会
// 解析成「未知地址族 / 属性过短」，`natType` 永远 Unknown、候选表里永远没有反射地址
// （真机定位：Cloudflare 回包 32 字节，`00 20 00 08 | 00 01 36 7c ...`）。
func parseAddressAttr(val []byte, xor bool, txid [12]byte) (ip string, port int, err error) {
	if len(val) < 8 {
		return "", 0, fmt.Errorf("stun: 地址属性过短")
	}
	family := val[1]
	p := int(binary.BigEndian.Uint16(val[2:4]))
	var addr []byte
	switch family {
	case stunFamilyIPv4:
		addr = append([]byte(nil), val[4:8]...)
	case stunFamilyIPv6:
		if len(val) < 20 {
			return "", 0, fmt.Errorf("stun: IPv6 属性过短")
		}
		addr = append([]byte(nil), val[4:20]...)
	default:
		return "", 0, fmt.Errorf("stun: 未知地址族 %#x", family)
	}
	if xor {
		// XOR-MAPPED-ADDRESS：端口 ^ (magic>>16)；地址与 `magic cookie || txid` 逐字节异或
		// （IPv4 用前 4 字节，IPv6 用完整 16 字节，RFC 5389 §15.2）。
		p ^= int(stunMagicCookie >> 16)
		mask := make([]byte, 16)
		binary.BigEndian.PutUint32(mask[0:4], stunMagicCookie)
		copy(mask[4:16], txid[:])
		for i := 0; i < len(addr) && i < len(mask); i++ {
			addr[i] ^= mask[i]
		}
	}
	ip = net.IP(addr).String()
	return ip, p, nil
}

// DiscoverNat 用**同一个 UdpHub socket**并发探测多个 STUN 服务器。
//
// ctx 取消 / 超时即返回已收集到的观测（可能为空）。失败只返回 Unknown，
// 绝不阻断组网（与 MobiHop 的异步后台探测语义一致）。
func DiscoverNat(ctx context.Context, hub *UdpHub, servers []string, timeout time.Duration) NatAssessment {
	return DiscoverNatFamily(ctx, hub, servers, timeout, 4)
}

// DiscoverNatFamily 用指定地址族（4 或 6）探测公共 STUN。
//
// IPv4 轮用来判定 NAT 类型（对称/锥形，NAT 语义只对 v4 有意义）；
// IPv6 轮只为了拿到**反射地址**——IPv6 通常没有 NAT，它就是本机全球地址，
// 直接作为免端口映射的直连候选。
func DiscoverNatFamily(ctx context.Context, hub *UdpHub, servers []string, timeout time.Duration, family int) NatAssessment {
	if hub == nil || len(servers) == 0 {
		return NatAssessment{Type: "Unknown"}
	}
	network := "udp4"
	if family == 6 {
		network = "udp6"
	}
	if timeout <= 0 {
		timeout = DefaultStunProbeMS * time.Millisecond
	}

	type waiter struct {
		ch chan StunMapping
	}
	var mu sync.Mutex
	waiters := make(map[[12]byte]*waiter)
	defer func() {
		mu.Lock()
		waiters = make(map[[12]byte]*waiter)
		mu.Unlock()
	}()

	// 复用 hub 的原始报文回调：STUN 不是 32B 帧，走 raw 通道。
	hub.SetRawHandler(func(b []byte) {
		if !looksLikeSTUN(b) {
			return
		}
		var txid [12]byte
		copy(txid[:], b[8:20])
		mu.Lock()
		w := waiters[txid]
		mu.Unlock()
		if w == nil {
			return
		}
		ip, port, err := parseBindingResponse(b, txid)
		if err != nil {
			return
		}
		select {
		case w.ch <- StunMapping{IP: ip, Port: port, Address: net.JoinHostPort(ip, strconv.Itoa(port))}:
		default:
		}
	})

	var wg sync.WaitGroup
	results := make([]StunMapping, 0, len(servers))
	var rmu sync.Mutex
	for _, srv := range servers {
		srv = strings.TrimSpace(srv)
		addr, err := net.ResolveUDPAddr(network, srv)
		if err != nil {
			continue
		}
		if (family == 6) != (addr.IP.To4() == nil) {
			continue // 该服务器没有对应地址族的记录：跳过，别用 v4 假装 v6
		}
		txid := randomTxID()
		w := &waiter{ch: make(chan StunMapping, 1)}
		mu.Lock()
		waiters[txid] = w
		mu.Unlock()

		wg.Add(1)
		go func(srv string, addr *net.UDPAddr, txid [12]byte, w *waiter) {
			defer wg.Done()
			defer func() {
				mu.Lock()
				delete(waiters, txid)
				mu.Unlock()
			}()
			if err := hub.SendProbeTo(ctx, addr, buildBindingRequest(txid)); err != nil {
				return
			}
			select {
			case m := <-w.ch:
				m.Server = srv
				rmu.Lock()
				results = append(results, m)
				rmu.Unlock()
			case <-time.After(timeout):
			case <-ctx.Done():
			}
		}(srv, addr, txid, w)
	}
	wg.Wait()
	return classifyMappings(results, family)
}

// randomTxID 生成 12 字节事务 ID。
func randomTxID() [12]byte {
	var t [12]byte
	// 复用加密随机源（crypto/rand 的 12 字节）
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	copy(t[:], b)
	return t
}

// classifyMappings 按映射一致性保守判定 NAT 形态。
func classifyMappings(ms []StunMapping, family int) NatAssessment {
	out := NatAssessment{Observations: ms}
	if len(ms) == 0 {
		out.Type = "Unknown"
		return out
	}
	if family == 6 {
		// IPv6 没有 NAT：映射就是本机地址。一致即可直接用；不一致说明多出口。
		consistent := true
		for _, m := range ms[1:] {
			if m.Address != ms[0].Address {
				consistent = false
			}
		}
		if consistent {
			out.Type = "Public"
			out.Reflexive6 = ms[0].Address
		} else {
			out.Type = "NAT6-varies"
		}
		return out
	}
	first := ms[0].Address
	sameIP := true
	sameAddr := true
	for _, m := range ms[1:] {
		if m.IP != ms[0].IP {
			sameIP = false
		}
		if m.Address != first {
			sameAddr = false
		}
	}
	switch {
	case !sameIP:
		// 不同服务器看到不同公网 IP：地址相关映射/多出口，保守按对称处理
		out.Type = "NAT4"
	case !sameAddr:
		// 同 IP 不同端口：对称 NAT
		out.Type = "NAT4"
	default:
		// 映射一致：锥形；未做 CHANGE-REQUEST 细分，保守 NAT3
		out.Type = "NAT3"
		out.Reflexive = first
	}
	return out
}
