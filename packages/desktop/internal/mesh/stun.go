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
	// Type：Unknown / NAT3（锥形，保守）/ NAT4（对称）
	Type string `json:"type"`
	// Reflexive 是某一致映射（ip:port），仅当探测成功时存在。
	Reflexive string `json:"reflexive,omitempty"`
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
func parseBindingResponse(b []byte) (addr string, port int, err error) {
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
			xorMapped, xorPort, _ = parseAddressAttr(val, true)
		case stunAttrMapped:
			mapped, mappedPort, _ = parseAddressAttr(val, false)
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
func parseAddressAttr(val []byte, xor bool) (ip string, port int, err error) {
	if len(val) < 4 {
		return "", 0, fmt.Errorf("stun: 地址属性过短")
	}
	family := val[0]
	p := int(binary.BigEndian.Uint16(val[1:3]))
	var addr []byte
	switch family {
	case stunFamilyIPv4:
		if len(val) < 8 {
			return "", 0, fmt.Errorf("stun: IPv4 属性过短")
		}
		addr = append([]byte(nil), val[3:7]...)
	case stunFamilyIPv6:
		if len(val) < 20 {
			return "", 0, fmt.Errorf("stun: IPv6 属性过短")
		}
		addr = append([]byte(nil), val[3:19]...)
	default:
		return "", 0, fmt.Errorf("stun: 未知地址族 %#x", family)
	}
	if xor {
		// XOR-MAPPED-ADDRESS：端口 ^ (magic>>16)，IPv4 地址逐字节与 magic 异或；
		// IPv6 还要再异或事务 ID 的后 12 字节（这里只做 IPv4，IPv6 直接返回原值）。
		p ^= int(stunMagicCookie >> 16)
		if family == stunFamilyIPv4 {
			cookie := [4]byte{}
			binary.BigEndian.PutUint32(cookie[:], stunMagicCookie)
			for i := 0; i < 4; i++ {
				addr[i] ^= cookie[i]
			}
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
	if hub == nil || len(servers) == 0 {
		return NatAssessment{Type: "Unknown"}
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
		ip, port, err := parseBindingResponse(b)
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
		addr, err := net.ResolveUDPAddr("udp", srv)
		if err != nil {
			continue
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
	return classifyMappings(results)
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
func classifyMappings(ms []StunMapping) NatAssessment {
	out := NatAssessment{Observations: ms}
	if len(ms) == 0 {
		out.Type = "Unknown"
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
