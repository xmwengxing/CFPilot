//go:build mesh

package mesh

// P3：Punch 编排（对齐 MobiHop punch_runtime.rs 的最小可验证子集）。
//
// 流程（与 MobiHop 一致的部分）：
//  1. 会话经**中继**建立后，立刻经该链路发 PunchRequest（携带本机候选）；
//  2. 对端回 PunchReply（携带它的候选），双方按 ~100ms 间隔向对方候选发 PunchProbe；
//  3. 收到 PunchProbe 的一方回 PunchAck（回到**探测来源地址**），并回发一条 PunchProbe
//     做**反向证明**（probe-back）——否则响应方永远拿不到「对端 Ack」这个直连证据，
//     升级只能是单边的（MobiHop 2026-11-19 修的正是这个不对称）；
//  4. **只有收到 PunchAck**（或收到来自候选地址的合法帧）才把链路从"中继"升级为"直连"；
//     打洞失败则保持不变（继续走中继）——绝不静默切出口。
//
// 与 MobiHop 的差异（如实标注）：
//   - 未实现 `punch_at_ms` 的双方时钟对齐（本地直接立即开打；MobiHop 用约定时刻同步）。
//
// 关键纪律：**信令走现有链路（通常是中继），探测走 UdpHub 同一个 socket**。
// 用另一个 socket 会让 NAT 映射不一致，打洞必然失败。

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
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
	state  string // idle / probing / retrying / direct / failed
	kind   string // ipv6 / stun / host / port-predict / wss
	round  uint32
}

const (
	punchProbeInterval = 100 * time.Millisecond
	punchProbeWindow   = 3 * time.Second
	// 持续打洞：每轮窗口结束后按 2s/5s/10s/30s 退避重试，最长 5 分钟；
	// 对端上线晚、STUN 结果回来晚、IPv6 路由临时不可用时都能最终成功。
	punchRetryBase  = 2 * time.Second
	punchRetryMax   = 30 * time.Second
	punchRetryLimit = 5 * time.Minute

	// 硬对称洗牌扫描（对齐 MobiHop HARD_SYM_* 与 easytier send_punch_packet_hard_sym）：
	// 跨度 2048、步长 1021（与 2048 互质 ⇒ [0,2048) 上的置换，连续调用不重复），
	// 每个探测间隔发一批（≈ hardSymBatch/0.1s ≈ 400 pkt/s）。
	hardSymSpan     = 2048
	hardSymStep     = 1021
	hardSymBatch    = 40
	hardSymPortBase = 1024

	// probeBackTracked 上限：防止对端用随机 nonce 把去重表撑爆。
	probeBackTracked = 256
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

// localIPv6s 收集本机可用于直连的 IPv6 全球地址（排除回环 / 链路本地 / ULA）。
func localIPv6s() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP
		if ip.To4() != nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		if !ip.IsGlobalUnicast() {
			continue
		}
		out = append(out, ip.String())
	}
	return out
}

// candidateUDP 把候选地址转成 UDPAddr（v4 / v6 都支持）。
func candidateUDP(c Candidate) *net.UDPAddr {
	switch {
	case c.Addr.V4 != nil:
		v4 := c.Addr.V4
		return &net.UDPAddr{
			IP:   net.IPv4(v4.IP[0], v4.IP[1], v4.IP[2], v4.IP[3]),
			Port: int(v4.Port),
		}
	case c.Addr.V6 != nil:
		v6 := c.Addr.V6
		ip := make(net.IP, net.IPv6len)
		copy(ip, v6.IP[:])
		return &net.UDPAddr{IP: ip, Port: int(v6.Port)}
	default:
		return nil
	}
}

// candidateKey 用于候选去重。
func candidateKey(c Candidate) string {
	if a := candidateUDP(c); a != nil {
		return a.String()
	}
	return ""
}

// publicAddrCandidate 把配置里的 `public_addr` 变成固定端口候选。
//
// 语义（对齐 MobiHop `add_static_reflexive`）：手工声明的外网地址最可信、
// 端口固定，**排在候选表最前**；它不会按 skip 展开、也不参与端口偏移校准。
func (m *meshLifecycle) publicAddrCandidate() *Candidate {
	raw := m.cfg.PublicAddr
	if raw == "" {
		return nil
	}
	addr, err := ParsePublicAddr(raw)
	if err != nil || addr.Port == 0 {
		return nil
	}
	if addr.IP.IsLoopback() || addr.IP.IsPrivate() || addr.IP.IsLinkLocalUnicast() {
		return nil // 校验已在 Config.Validate 拒绝，这里再兜一层
	}
	if addr.IP.To4() != nil {
		v4 := addr.IP.To4()
		c := Candidate{
			Addr:     NewV4Addr([4]byte{v4[0], v4[1], v4[2], v4[3]}, uint16(addr.Port)),
			Kind:     CandidateServerReflexive,
			Priority: PriorityFor(CandidateServerReflexive, false) + 1000,
		}
		return &c
	}
	v6 := addr.IP.To16()
	var ip6 [16]byte
	copy(ip6[:], v6)
	c := Candidate{
		Addr:     NewV6Addr(ip6, uint16(addr.Port)),
		Kind:     CandidateServerReflexive,
		Priority: PriorityFor(CandidateServerReflexive, true) + 1000,
	}
	return &c
}

// localCandidates 生成本机候选：
//  1. `public_addr`（用户声明，固定端口，排最前）
//  2. STUN 反射地址（IPv6 优先：无 NAT，免映射即直连）
//  3. 网卡 Host 候选（IPv6 全球地址 + IPv4）
//
// 优先级沿用 MobiHop 常量（Host > ServerReflexive > Relayed，v6 有加分）。
func (m *meshLifecycle) localCandidates() []Candidate {
	port := listenPort(m.cfg.Listen)
	out := make([]Candidate, 0, 8)
	seen := make(map[string]bool, 8)
	add := func(c Candidate) {
		if k := candidateKey(c); k != "" && !seen[k] {
			seen[k] = true
			out = append(out, c)
		}
	}
	if pub := m.publicAddrCandidate(); pub != nil {
		add(*pub)
	}
	m.natMu.Lock()
	nat := m.nat
	m.natMu.Unlock()
	if nat.Reflexive6 != "" {
		if addr, err := net.ResolveUDPAddr("udp", nat.Reflexive6); err == nil && addr.IP.To4() == nil {
			var ip6 [16]byte
			copy(ip6[:], addr.IP.To16())
			add(Candidate{
				Addr:     NewV6Addr(ip6, uint16(addr.Port)),
				Kind:     CandidateServerReflexive,
				Priority: PriorityFor(CandidateServerReflexive, true),
			})
		}
	}
	if nat.Reflexive != "" {
		if addr, err := net.ResolveUDPAddr("udp", nat.Reflexive); err == nil && addr.IP.To4() != nil {
			v4 := addr.IP.To4()
			add(Candidate{
				Addr:     NewV4Addr([4]byte{v4[0], v4[1], v4[2], v4[3]}, uint16(addr.Port)),
				Kind:     CandidateServerReflexive,
				Priority: PriorityFor(CandidateServerReflexive, false),
			})
		}
	}
	// Host 候选的端口必须是**监听端口**：NAT 保活与打洞都依赖同一个映射。
	for _, raw := range localIPv6s() {
		ip := net.ParseIP(raw)
		if ip == nil || ip.To4() != nil {
			continue
		}
		// 虚拟 IP 不能做候选：向它发 UDP 会被本机 TUN 吃掉，绕一圈又从
		// 隧道的另一端出来，等于自己给自己造了一条「直连」。
		if m.isVirtualMeshIP(ip) {
			continue
		}
		var ip6 [16]byte
		copy(ip6[:], ip.To16())
		add(Candidate{
			Addr:     NewV6Addr(ip6, uint16(port)),
			Kind:     CandidateHost,
			Priority: PriorityFor(CandidateHost, true),
		})
	}
	for _, raw := range localIPv4s() {
		ip := net.ParseIP(raw)
		if ip == nil {
			continue
		}
		v4 := ip.To4()
		if v4 == nil {
			continue
		}
		if m.isVirtualMeshIP(ip) {
			continue
		}
		add(Candidate{
			Addr:     NewV4Addr([4]byte{v4[0], v4[1], v4[2], v4[3]}, uint16(port)),
			Kind:     CandidateHost,
			Priority: PriorityFor(CandidateHost, false),
		})
	}
	return out
}

// isVirtualMeshIP 报告地址是否属于本网状网络的虚拟 IP（自身或任何静态对端）。
//
// 这些地址只在 TUN 内部有意义：直接向它们发 UDP 会被本机隧道吃掉，再从
// 对端隧道口出来（源地址也是虚拟 IP）。于是「打洞成功」实际是把链路换成一条
// 指向虚拟 IP 的假直连腿（真机：via=udp、中继侧看不到任何 Data、甚至无限封装）。
func (m *meshLifecycle) isVirtualMeshIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if own := net.ParseIP(m.cfg.VirtualIP); own != nil && own.Equal(ip) {
		return true
	}
	for _, p := range m.cfg.Peers {
		if vip := net.ParseIP(p.VirtualIP); vip != nil && vip.Equal(ip) {
			return true
		}
	}
	return false
}

// isSymmetricNat 报告 IPv4 侧是否判成对称映射（只有这时才启用硬对称扫描）。
func (m *meshLifecycle) isSymmetricNat() bool {
	m.natMu.Lock()
	defer m.natMu.Unlock()
	return m.nat.Type == "NAT4"
}

// hardSymTargets 生成硬对称洗牌扫描的目标（跨度 2048、步长 1021 的置换）。
//
// 只对**对端的公网 IP**（反射候选）换端口扫：对端在对称 NAT 后时，
// 它对每个目的端口都会重新分配映射，扫不中端口就永远打不通。
func (m *meshLifecycle) hardSymTargets(peer NodeID, cands []Candidate, count int) []*net.UDPAddr {
	if count <= 0 {
		return nil
	}
	ips := make([]net.IP, 0, 2)
	for _, c := range cands {
		if c.Kind != CandidateServerReflexive {
			continue
		}
		if a := candidateUDP(c); a != nil && a.IP.To4() != nil {
			ips = append(ips, a.IP)
		}
	}
	if len(ips) == 0 {
		return nil
	}
	m.punchMu.Lock()
	if m.hardSymCursor == nil {
		m.hardSymCursor = make(map[NodeID]uint32)
	}
	base := m.hardSymCursor[peer]
	m.hardSymCursor[peer] = base + uint32(count)
	m.punchMu.Unlock()

	out := make([]*net.UDPAddr, 0, count*len(ips))
	for i := 0; i < count; i++ {
		port := hardSymPortBase + int(((base+uint32(i))*hardSymStep)%hardSymSpan)
		for _, ip := range ips {
			out = append(out, &net.UDPAddr{IP: ip, Port: port})
		}
	}
	return out
}

// shouldProbeBack 保证同一 (peer, nonce) 只回发一次 probe-back，防止互探回环。
func (m *meshLifecycle) shouldProbeBack(peer NodeID, nonce uint64) bool {
	key := fmt.Sprintf("%x|%d", peer, nonce)
	m.punchMu.Lock()
	defer m.punchMu.Unlock()
	if m.probeBackSent == nil {
		m.probeBackSent = make(map[string]struct{})
	}
	if _, ok := m.probeBackSent[key]; ok {
		return false
	}
	if len(m.probeBackSent) >= probeBackTracked {
		for k := range m.probeBackSent {
			delete(m.probeBackSent, k)
			break
		}
	}
	m.probeBackSent[key] = struct{}{}
	return true
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

// startPunch 经现有链路（通常是中继）启动持续打洞循环。
func (m *meshLifecycle) startPunch(peer NodeID, via PeerLink) {
	if m.cfg.DisablePunch || via == nil {
		return
	}
	m.punchMu.Lock()
	if run := m.punch[peer]; run != nil && (run.state == "probing" || run.state == "retrying") {
		m.punchMu.Unlock()
		return
	}
	m.punchMu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.punchLoop(peer, via)
	}()
}

// punchLoop 在 WSS 链路上持续重试打洞，直到直连升级成功或达到总时限。
func (m *meshLifecycle) punchLoop(peer NodeID, via PeerLink) {
	backoff := punchRetryBase
	deadline := time.Now().Add(punchRetryLimit)
	for round := uint32(0); ; round++ {
		if m.runCtx != nil && m.runCtx.Err() != nil {
			return
		}
		if time.Now().After(deadline) {
			m.setPunchState(peer, "failed", "wss")
			return
		}
		if !m.punchOnce(peer, via, round) {
			return
		}
		m.setPunchState(peer, "retrying", punchKindForCandidates(m.localCandidates()))
		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-m.runCtx.Done():
			timer.Stop()
			return
		}
		// 直连已由 PunchAck 升级成功：停止重试，不要无谓占 WSS 带宽。
		if state, _ := m.punchState(peer); state == "direct" {
			return
		}
		if backoff < punchRetryMax {
			backoff *= 2
			if backoff > punchRetryMax {
				backoff = punchRetryMax
			}
		}
	}
}

// punchOnce 发一轮 PunchRequest；成功返回 true 表示还需继续下一轮。
func (m *meshLifecycle) punchOnce(peer NodeID, via PeerLink, round uint32) bool {
	cands := m.localCandidates()
	if len(cands) == 0 {
		return false
	}
	nonce := randUint64()
	m.punchMu.Lock()
	m.punch[peer] = &punchRun{nonce: nonce, at: time.Now(), state: "probing", kind: punchKindForCandidates(cands), round: round}
	m.punchMu.Unlock()

	msg := &PunchMessage{PunchReq: &PunchRequest{From: m.cfg.NodeID, Candidates: cands, Nonce: nonce}}
	frame, err := m.encodePunchFrame(peer, msg)
	if err != nil {
		return false
	}
	if err := via.Send(context.Background(), frame); err != nil {
		return false
	}
	if m.cfg.Verbose {
		log.Printf("[mesh] 经中继向 %x 发起打洞（第 %d 轮，候选 %d 个，对称NAT=%v）", peer[:4], round+1, len(cands), m.isSymmetricNat())
	}
	return true
}

func (m *meshLifecycle) setPunchState(peer NodeID, state, kind string) {
	m.punchMu.Lock()
	if m.punch == nil {
		m.punch = make(map[NodeID]*punchRun)
	}
	run := m.punch[peer]
	if run == nil {
		run = &punchRun{}
		m.punch[peer] = run
	}
	run.state, run.kind = state, kind
	m.punchMu.Unlock()
}

func (m *meshLifecycle) punchState(peer NodeID) (string, string) {
	m.punchMu.Lock()
	defer m.punchMu.Unlock()
	run := m.punch[peer]
	if run == nil {
		return "", ""
	}
	return run.state, run.kind
}

// punchKindForCandidates 挑一个最值得展示的候选类型（IPv6 > STUN > Host）。
func punchKindForCandidates(cands []Candidate) string {
	kind := ""
	for _, c := range cands {
		a := candidateUDP(c)
		if a == nil {
			continue
		}
		switch c.Kind {
		case CandidateServerReflexive:
			if a.IP.To4() == nil {
				return "ipv6"
			}
			if kind == "" {
				kind = "stun"
			}
		case CandidateHost:
			if a.IP.To4() == nil {
				return "ipv6"
			}
			if kind == "" {
				kind = "host"
			}
		}
	}
	if kind == "" {
		return "wss"
	}
	return kind
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
		hasRun := run != nil
		m.punchMu.Unlock()
		// 响应方没有 punchRun（它只在收到 PunchReq 时开始探测），不能因此丢掉候选。
		if hasRun && run.nonce != reply.Nonce {
			return // nonce 不匹配：过期的应答，忽略
		}
		m.beginProbe(peer, reply.Candidates, reply.Nonce)
	case msg.PunchProbe != nil:
		probe := msg.PunchProbe
		// ⚠️ 经中继转发来的帧源地址是**中继**，不是对端。把它当直连证据会把
		// 中继腿换成「到中继地址的直连腿」（Send 不再经中继，对端收不到），
		// 真机症状：握手已成功、via=udp、rtt 有值，但 ping 100% 丢。
		// 只有真正从对端地址直发的探针才算直连可达。
		if remote == nil || m.hub.isRelayAddr(remote) || m.isVirtualMeshIP(remote.IP) {
			return // 没有真实源地址 / 中继回显 / 隧道自环：都不算直连
		}
		ack := &PunchMessage{PunchAck: &PunchAck{From: m.cfg.NodeID, Nonce: probe.Nonce}}
		if frame, e := m.encodePunchFrame(peer, ack); e == nil {
			_ = m.hub.SendProbeTo(context.Background(), remote, frame)
		}
		// 反向证明（probe-back）：让对端也从我们的真实地址看到一条 PunchProbe，
		// 它回 Ack 后双方都有「对端直连可达」的证据。每个 (peer,nonce) 只发一次。
		if m.shouldProbeBack(peer, probe.Nonce) {
			back := &PunchMessage{PunchProbe: &PunchProbe{From: m.cfg.NodeID, Nonce: probe.Nonce}}
			if frame, e := m.encodePunchFrame(peer, back); e == nil {
				_ = m.hub.SendProbeTo(context.Background(), remote, frame)
			}
		}
		m.upgradeToDirect(peer, remote)
	case msg.PunchAck != nil:
		// 同上：中继转发回来的 Ack 只说明「中继通」，不说明「直连通」。
		if remote == nil || m.hub.isRelayAddr(remote) || m.isVirtualMeshIP(remote.IP) {
			return
		}
		if m.cfg.Verbose {
			log.Printf("[mesh] 收到 PunchAck：%x 直连可达 %s", peer[:4], remote)
		}
		m.upgradeToDirect(peer, remote)
	}
}

// beginProbe 向对端候选喷洒 PunchProbe（窗口 3s、间隔 100ms）。
//
// 对端判为对称映射时，额外做硬对称洗牌扫描：同一公网 IP 上按置换表换端口，
// 每轮 40 个目标；否则只打候选表里的确切地址。
func (m *meshLifecycle) beginProbe(peer NodeID, cands []Candidate, nonce uint64) {
	if m.hub == nil {
		return // 未启动/UDP 通道不可用（单元测试或半初始化状态）
	}
	targets := make([]*net.UDPAddr, 0, len(cands))
	for _, c := range cands {
		if a := candidateUDP(c); a != nil {
			// 虚拟 IP 候选一律不打：探针会被本机 TUN 送回对端隧道口，
			// 制造出「已直连」的假象（见 isVirtualMeshIP）。
			if !m.isVirtualMeshIP(a.IP) {
				targets = append(targets, a)
			}
		}
	}
	if len(targets) == 0 {
		return
	}
	hardSym := m.isSymmetricNat()
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
			if hardSym {
				for _, addr := range m.hardSymTargets(peer, cands, hardSymBatch) {
					_ = m.hub.SendProbeTo(context.Background(), addr, frame)
				}
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
	addr = canonicalAddr(addr)
	m.mu.Lock()
	cur := m.links[peer]
	if cur != nil && !cur.IsRelayed() {
		// 直连已经生效（例如 onIncoming 先完成升级）：仍然要锁定档位，
		// 否则降级控制器会按残留的 WSS 探针窗口把已建立的 P2P 切回中继。
		if m.degrade != nil {
			m.degrade.LockDirect(peer)
		}
		m.mu.Unlock()
		return
	}
	m.links[peer] = m.hub.LinkTo(addr)
	m.mu.Unlock()
	if m.degrade != nil {
		m.degrade.LockDirect(peer)
	}
	m.setPunchState(peer, "direct", punchAddrKind(addr))
	if m.cfg.Verbose {
		log.Printf("[mesh] 打洞成功：%x 升级为直连 %s", peer[:4], addr)
	}
}

func punchAddrKind(addr *net.UDPAddr) string {
	if addr == nil {
		return "wss"
	}
	if addr.IP.To4() == nil {
		return "ipv6"
	}
	if addr.IP.IsPrivate() {
		return "host"
	}
	return "stun"
}
