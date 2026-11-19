//go:build mesh

package mesh

// P3：Punch 编排（对齐 MobiHop punch_runtime.rs 的最小可验证子集）。
//
// 流程（与 MobiHop 一致的部分）：
//   1. 会话经**中继**建立后，立刻经该链路发 PunchRequest（携带本机候选）；
//   2. 对端回 PunchReply（携带它的候选），双方按 ~100ms 间隔向对方候选发 PunchProbe；
//   3. 收到 PunchProbe 的一方回 PunchAck（回到**探测来源地址**）；
//   4. **只有收到 PunchAck**（或收到来自候选地址的合法帧）才把链路从"中继"升级为"直连"；
//      打洞失败则保持不变（继续走中继）——绝不静默切出口。
//
// 与 MobiHop 的差异（如实标注）：
//   - 未实现 `punch_at_ms` 的双方时钟对齐（本地直接立即开打；MobiHop 用约定时刻同步）；
//   - 未做 2s/5s/10s 退避重试（只在会话建立时尝试一轮）；
//   - 未引入 Relayed 候选（本子集的中继腿已由 WSS 承担）。
//
// 关键纪律：**信令走现有链路（通常是中继），探测走 UdpHub 同一个 socket**。
// 用另一个 socket 会让 NAT 映射不一致，打洞必然失败。

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"log"
	"net"
	"strconv"
	"time"
)

// punchRun 是单轮打洞的状态。
type punchRun struct {
	nonce  uint64
	target []Candidate // 对端候选（用于探测）
	at     time.Time
}

const (
	punchProbeInterval = 100 * time.Millisecond
	punchProbeWindow   = 3 * time.Second
)

// randUint64 生成 nonce。
func randUint64() uint64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return binary.BigEndian.Uint64(b[:])
}

// listenPort 从 "0.0.0.0:51820" 里取端口。
func listenPort(listen string) int {
	_, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		return 51820
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 {
		return 51820
	}
	return port
}

// localCandidates 生成本机候选：Host（各网卡 IPv4）+ ServerReflexive（STUN 映射）。
//
// 优先级沿用 MobiHop 常量（Host > ServerReflexive > Relayed）。
func (m *meshLifecycle) localCandidates() []Candidate {
	port := listenPort(m.cfg.Listen)
	out := make([]Candidate, 0, 4)
	for _, raw := range localIPv4s() {
		ip := net.ParseIP(raw)
		if ip == nil {
			continue
		}
		v4 := ip.To4()
		if v4 == nil {
			continue
		}
		out = append(out, Candidate{
			Addr:     NewV4Addr([4]byte{v4[0], v4[1], v4[2], v4[3]}, uint16(port)),
			Kind:     CandidateHost,
			Priority: PriorityFor(CandidateHost, false),
		})
	}
	m.natMu.Lock()
	reflexive := m.nat.Reflexive
	m.natMu.Unlock()
	if reflexive != "" {
		if addr, err := net.ResolveUDPAddr("udp", reflexive); err == nil && addr.IP.To4() != nil {
			v4 := addr.IP.To4()
			out = append(out, Candidate{
				Addr:     NewV4Addr([4]byte{v4[0], v4[1], v4[2], v4[3]}, uint16(addr.Port)),
				Kind:     CandidateServerReflexive,
				Priority: PriorityFor(CandidateServerReflexive, false),
			})
		}
	}
	return out
}

// candidateUDP 把候选地址转成 UDPAddr；IPv6 候选取本机子集不支持，返回 nil。
func candidateUDP(c Candidate) *net.UDPAddr {
	if c.Addr.V4 == nil {
		return nil
	}
	v4 := c.Addr.V4
	return &net.UDPAddr{
		IP:   net.IPv4(v4.IP[0], v4.IP[1], v4.IP[2], v4.IP[3]),
		Port: int(v4.Port),
	}
}

// encodePunchFrame 封装 0x05 PunchMessage 帧。
func (m *meshLifecycle) encodePunchFrame(dst NodeID, msg *PunchMessage) ([]byte, error) {
	payload, err := EncodePunchMessage(msg)
	if err != nil {
		return nil, err
	}
	return (&Frame{
		Version: m.wireVersionFor(dst),
		Type:    MsgHolePunch, TTL: DefaultTTL,
		Payload: payload, Src: m.cfg.NodeID, Dst: dst,
	}).Encode()
}

// startPunch 经现有链路（通常是中继）发起一轮打洞。
func (m *meshLifecycle) startPunch(peer NodeID, via PeerLink) {
	if m.cfg.DisablePunch || via == nil {
		return
	}
	cands := m.localCandidates()
	if len(cands) == 0 {
		return
	}
	nonce := randUint64()
	m.punchMu.Lock()
	m.punch[peer] = &punchRun{nonce: nonce, at: time.Now()}
	m.punchMu.Unlock()

	msg := &PunchMessage{PunchReq: &PunchRequest{From: m.cfg.NodeID, Candidates: cands, Nonce: nonce}}
	frame, err := m.encodePunchFrame(peer, msg)
	if err != nil {
		return
	}
	_ = via.Send(context.Background(), frame)
	if m.cfg.Verbose {
		log.Printf("[mesh] 经中继向 %x 发起打洞（候选 %d 个）", peer[:4], len(cands))
	}
}

// handlePunch 处理 0x05 帧（由 UdpHub 的独立观察通道调用，与活跃链路无关）。
//
// remote 是**真实源地址**：回 PunchAck 必须发给它（而不是活跃 link 的 PeerAddr，
// 后者在切 WSS 时为 nil）。对齐 MobiHop hub.rs 的 observer 语义（CROSS_PROJECT_SYNC §11.5）。
func (m *meshLifecycle) handlePunch(peer NodeID, parsed *Frame, remote *net.UDPAddr) {
	if m.cfg.DisablePunch {
		return
	}
	msg, err := DecodePunchMessage(parsed.Payload)
	if err != nil {
		return
	}
	// 回信令的链路：中继阶段经中继链路回；有 remote 时探测类直接回 remote。
	var replyLink PeerLink
	m.mu.Lock()
	replyLink = m.links[peer]
	m.mu.Unlock()
	switch {
	case msg.PunchReq != nil:
		req := msg.PunchReq
		reply := &PunchMessage{PunchReply: &PunchReply{
			From: m.cfg.NodeID, Candidates: m.localCandidates(), Nonce: req.Nonce,
		}}
		if frame, e := m.encodePunchFrame(peer, reply); e == nil && replyLink != nil {
			_ = replyLink.Send(context.Background(), frame)
		}
		m.beginProbe(peer, req.Candidates, req.Nonce)
	case msg.PunchReply != nil:
		reply := msg.PunchReply
		m.punchMu.Lock()
		run := m.punch[peer]
		m.punchMu.Unlock()
		if run == nil || run.nonce != reply.Nonce {
			return // nonce 不匹配：过期的应答，忽略
		}
		m.beginProbe(peer, reply.Candidates, reply.Nonce)
	case msg.PunchProbe != nil:
		probe := msg.PunchProbe
		if remote == nil {
			return // 没有真实源地址，无法回 Ack
		}
		ack := &PunchMessage{PunchAck: &PunchAck{From: m.cfg.NodeID, Nonce: probe.Nonce}}
		if frame, e := m.encodePunchFrame(peer, ack); e == nil {
			_ = m.hub.SendProbeTo(context.Background(), remote, frame)
		}
		m.upgradeToDirect(peer, remote)
	case msg.PunchAck != nil:
		if remote == nil {
			return
		}
		m.upgradeToDirect(peer, remote)
	}
}

// beginProbe 向对端候选喷洒 PunchProbe（窗口 3s、间隔 100ms）。
func (m *meshLifecycle) beginProbe(peer NodeID, cands []Candidate, nonce uint64) {
	if m.hub == nil {
		return // 未启动/UDP 通道不可用（单元测试或半初始化状态）
	}
	// 只取 IPv4 候选（本机子集的 UDP 通道只跑 IPv4）
	targets := make([]*net.UDPAddr, 0, len(cands))
	for _, c := range cands {
		if a := candidateUDP(c); a != nil {
			targets = append(targets, a)
		}
	}
	if len(targets) == 0 {
		return
	}
	msg := &PunchMessage{PunchProbe: &PunchProbe{From: m.cfg.NodeID, Nonce: nonce}}
	frame, err := m.encodePunchFrame(peer, msg)
	if err != nil {
		return
	}
	go func() {
		deadline := time.Now().Add(punchProbeWindow)
		for time.Now().Before(deadline) {
			for _, addr := range targets {
				_ = m.hub.SendProbeTo(context.Background(), addr, frame)
			}
			time.Sleep(punchProbeInterval)
		}
	}()
}

// upgradeToDirect 把该对端的链路替换为到候选地址的直连 hubLink。
//
// 只有「当前是中继腿」时才替换：直连已经可用时不做无谓切换。
func (m *meshLifecycle) upgradeToDirect(peer NodeID, addr *net.UDPAddr) {
	if addr == nil || m.hub == nil {
		return
	}
	m.mu.Lock()
	cur := m.links[peer]
	if cur != nil && !cur.IsRelayed() {
		m.mu.Unlock()
		return
	}
	m.links[peer] = m.hub.LinkTo(addr)
	m.mu.Unlock()
	if m.cfg.Verbose {
		log.Printf("[mesh] 打洞成功：%x 升级为直连 %s", peer[:4], addr)
	}
}
