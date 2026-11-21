package mesh

import (
	"context"
	"crypto/x509"
	"fmt"
	"log"
	"sync"
	"time"
)

// DegradeController 是 UDP↔WSS 切换控制器（Phase 3b-2c 阶段 2）。
//
// 编排（对齐 MobiHop node.rs:2491,2642-2675,3183-3255）：
//   - 200ms 测量 tick：RecordSample（record_if_sent 语义）
//   - 1s 控制 tick：SendProbe + Observe（判据）→ 执行切换
//   - 降级：UDP 连续 3 窗差 → 建 WSS 连盲中继房间 → replace_link(active=WSS)
//   - 回切：WSS 期 UdpProbe 连续 3 窗好 → replace_link(active=UDP) → 关旧 WSS
//
// 切换只换 PeerLink，不动 Session（node.rs:2429）。
// switchSettleTime 是链路切换后的稳定期：探针窗口（20 样本 × 1s）需要这么久
// 才能完全反映新链路，期间禁止反向切换，避免 WSS↔UDP 来回震荡（真机踩到）。
const switchSettleTime = 12 * time.Second

type sharedRoomLinkProvider interface {
	PeerLinkFor(NodeID) PeerLink
}

type DegradeController struct {
	mu          sync.Mutex
	selfID      NodeID
	peers       map[NodeID]*ctrlPeer
	policy      *DegradePolicy
	probes      *ProbeTracker
	relayDomain string
	relayRoom   string
	// relayConnectIP 非空时，WSS 的 TCP 目标换成该 IP（SNI/Host 仍用域名），
	// 即「优选入口 IP」能力（WsUrl.ConnectIP）。
	relayConnectIP     string
	rootCAs            *x509.CertPool
	room               sharedRoomLinkProvider
	sharedRoomRequired bool
	verbose            bool

	// switchFn 执行链路切换（由 Lifecycle 注入：(peer, link, kind)）
	switchFn func(peer NodeID, link PeerLink, kind TransportKind)
	// closeWssFn 关闭某 peer 的 WSS 链路
	closeWssFn func(peer NodeID)
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	// graceTicks 启动宽限：前 N 个 tick 只发探针建立窗口、不判据，
	// 避免启动瞬态丢包（对端未就绪）误触发降级（真机暴露）。
	graceTicks uint32
	// lastSwitch 记录最近一次链路切换时刻：切换后 probe 窗口里残留的丢包
	// 不代表新链路质量，立刻允许反向切换会造成 WSS↔UDP 来回震荡（真机踩到）。
	lastSwitch map[NodeID]time.Time
}

type ctrlPeer struct {
	kind    TransportKind
	udpAddr string
	wssLink *WssLink
	// activeKind 当前激活档位
	activeKind TransportKind
	// directLocked 表示已通过打洞确认真实 UDP 直连可达。
	// 锁定后不再因探针窗口的瞬时丢包切回中继：真机上探针拥塞/链路抖动
	// 会让 UDP↔WSS 来回震荡，已建立的 P2P 通道被中继抢占，表现为
	// ping 间歇 100% 丢、TCP/SSH 全部超时。只有 P2P 真正不可用时才允许降级。
	directLocked bool
}

func NewDegradeController(selfID NodeID, probes *ProbeTracker, relayDomain, relayRoom, relayConnectIP string, rootCAs *x509.CertPool, verbose bool) *DegradeController {
	return &DegradeController{
		selfID:         selfID,
		peers:          make(map[NodeID]*ctrlPeer),
		policy:         NewDegradePolicy(),
		probes:         probes,
		relayDomain:    relayDomain,
		relayRoom:      relayRoom,
		relayConnectIP: relayConnectIP,
		rootCAs:        rootCAs,
		verbose:        verbose,
		graceTicks:     lossWindowTicks, // 覆盖整个探针窗口滚出时间（真机启动瞬态防护）
		lastSwitch:     make(map[NodeID]time.Time),
	}
}

func (c *DegradeController) SetSwitchFn(fn func(NodeID, PeerLink, TransportKind)) { c.switchFn = fn }
func (c *DegradeController) SetCloseWssFn(fn func(NodeID))                        { c.closeWssFn = fn }

func (c *DegradeController) SetWssRoom(room sharedRoomLinkProvider) {
	c.mu.Lock()
	c.room = room
	c.mu.Unlock()
}

func (c *DegradeController) SetSharedWssRoomRequired(required bool) {
	c.mu.Lock()
	c.sharedRoomRequired = required
	c.mu.Unlock()
}

// AddPeer 注册一个对端（初始 UDP 档位）。
func (c *DegradeController) AddPeer(id NodeID, udpAddr string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.peers[id] = &ctrlPeer{kind: TransportUDP, udpAddr: udpAddr, activeKind: TransportUDP}
}

func (c *DegradeController) SetActiveKind(id NodeID, kind TransportKind) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.peers[id]
	if p == nil {
		p = &ctrlPeer{}
		c.peers[id] = p
	}
	p.activeKind = kind
	if kind == TransportWSS {
		p.directLocked = false
	}
}

// LockDirect 把对端标记为已确认 UDP 直连，并锁定该档位。
func (c *DegradeController) LockDirect(id NodeID) {
	c.mu.Lock()
	p := c.peers[id]
	if p == nil {
		p = &ctrlPeer{}
		c.peers[id] = p
	}
	p.activeKind = TransportUDP
	p.directLocked = true
	c.mu.Unlock()
	c.policy.BeginCooldown(id)
}

func (c *DegradeController) IsDirectLocked(id NodeID) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.peers[id]
	return p != nil && p.directLocked && p.activeKind == TransportUDP
}

func (c *DegradeController) AddPeerWithoutUDP(id NodeID, kind TransportKind) {
	c.mu.Lock()
	p := c.peers[id]
	if p == nil {
		p = &ctrlPeer{}
		c.peers[id] = p
	}
	if p.directLocked && kind == TransportWSS {
		c.mu.Unlock()
		return
	}
	p.activeKind = kind
	c.mu.Unlock()
	c.policy.BeginCooldown(id)
}

func (c *DegradeController) HasUDPPeer(id NodeID) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.peers[id]
	return p != nil && p.udpAddr != ""
}

// Start 启动测量/控制循环。
func (c *DegradeController) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	// 启动冷却：避免初始化期间探针尚未收敛（启动瞬间的丢包）误触发降级。
	// 对齐 MobiHop begin_cooldown_all（node.rs:3147-3155）。
	for id := range c.peers {
		c.policy.BeginCooldown(id)
	}
	c.wg.Add(2)
	go c.measureLoop(runCtx)
	go c.controlLoop(runCtx)
}

// Stop 停止循环。
func (c *DegradeController) Stop() {
	if c.cancel != nil {
		c.cancel()
	}
	c.wg.Wait()
}

// measureLoop 200ms 测量 tick（router.rs:36）。
func (c *DegradeController) measureLoop(ctx context.Context) {
	defer c.wg.Done()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.Lock()
			ids := make([]NodeID, 0, len(c.peers))
			for id := range c.peers {
				ids = append(ids, id)
			}
			c.mu.Unlock()
			for _, id := range ids {
				c.probes.RecordSample(id)
			}
		}
	}
}

// controlLoop 1s 控制 tick（node.rs:2491）。
func (c *DegradeController) controlLoop(ctx context.Context) {
	defer c.wg.Done()
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.tick(ctx)
		}
	}
}

func (c *DegradeController) inGrace() bool {
	if c.graceTicks > 0 {
		c.graceTicks--
		return true
	}
	return false
}

func (c *DegradeController) tick(ctx context.Context) {
	grace := c.inGrace() // 宽限期内只发探针建窗口、不判据
	c.mu.Lock()
	ids := make([]NodeID, 0, len(c.peers))
	for id, p := range c.peers {
		ids = append(ids, id)
		if p.activeKind == TransportWSS && p.udpAddr == "" {
			continue
		}
		// 每 1s 发链路探针（对齐 MobiHop：UDP 档位发 0x03 Ping 做 RTT/丢包测量，
		// WSS 档位发 0x08 UdpProbe 做回切验证）。两者共用 ProbeTracker。
		// ⚠️ 必须在 UDP 档位也发 —— 否则样本恒为 0，降级判据永远不触发（真机暴露）。
		_, _ = c.probes.SendProbe(ctx, id)
		_ = p // p 保留供后续档位特化
	}
	c.mu.Unlock()

	if grace {
		return // 启动宽限：只发探针建窗口，不判据
	}

	for _, id := range ids {
		if !c.HasUDPPeer(id) {
			continue
		}
		if c.IsDirectLocked(id) {
			continue
		}
		// 切换后 12 秒稳定期：等探针窗口完全刷新再允许反向切换。
		if last, ok := c.lastSwitch[id]; ok && time.Since(last) < switchSettleTime {
			continue
		}
		loss, samples, rtt := c.probes.Measurement(id)
		c.mu.Lock()
		p := c.peers[id]
		kind := p.activeKind
		c.mu.Unlock()

		d := c.policy.Observe(id, kind, loss, samples, rtt)
		switch d.Kind {
		case DecisionToWSS:
			c.lastSwitch[id] = time.Now()
			if err := c.switchToWSS(ctx, id); err != nil {
				if c.verbose {
					log.Printf("[mesh] 降级失败 peer=%x: %v", id[:4], err)
				}
			} else if c.verbose {
				log.Printf("[mesh] 降级到 WSS peer=%x: %s", id[:4], d.Reason)
			}
		case DecisionToUDP:
			c.lastSwitch[id] = time.Now()
			c.switchToUDP(id)
			if c.verbose {
				log.Printf("[mesh] 回切 UDP peer=%x: %s", id[:4], d.Reason)
			}
		}
	}
}

// switchToWSS 建 WSS 连盲中继房间并切换（node.rs:2403-2445）。
func (c *DegradeController) switchToWSS(ctx context.Context, id NodeID) error {
	c.mu.Lock()
	room := c.room
	sharedRoomRequired := c.sharedRoomRequired
	c.mu.Unlock()
	if room != nil {
		link := room.PeerLinkFor(id)
		c.AddPeerWithoutUDP(id, TransportWSS)
		c.mu.Lock()
		switchFn := c.switchFn
		c.mu.Unlock()
		c.policy.BeginCooldown(id)
		if switchFn != nil {
			switchFn(id, link, TransportWSS)
		}
		return nil
	}
	if sharedRoomRequired {
		return fmt.Errorf("盲中继共享房间尚未连接")
	}
	if c.relayDomain == "" || c.relayRoom == "" {
		return fmt.Errorf("未配置盲中继域名/房间，无法降级")
	}
	// ⚠️ peer_id 必须是**本机** NodeID：它标识「这条 WS 连接是谁」。
	// 早前写成对端 id，两端会用同一个 peer_id 入房 ⇒ Worker 的「同 peer 踢旧连」
	// 会互相踢掉，中继永远不稳定。帧的目标由 32B 头里的 dst 决定，不靠入房 id。
	url, err := RelayRoomURL(c.relayDomain, c.relayRoom, fmt.Sprintf("%016x", c.selfID))
	if err != nil {
		return err
	}
	parsed, err := ParseWsUrl(url)
	if err != nil {
		return err
	}
	// 优选入口 IP：只换 TCP 目标，SNI/Host 仍是 relayDomain（证书校验照旧）。
	if c.relayConnectIP != "" {
		parsed = parsed.WithConnectIP(c.relayConnectIP)
	}
	conn, err := DialWss(ctx, parsed, c.rootCAs)
	if err != nil {
		return err
	}
	wss := NewWssLink(conn)

	c.mu.Lock()
	p := c.peers[id]
	if p == nil {
		c.mu.Unlock()
		_ = conn.Close()
		return fmt.Errorf("未知 peer")
	}
	p.wssLink = wss
	p.activeKind = TransportWSS
	switchFn := c.switchFn
	c.mu.Unlock()

	c.policy.BeginCooldown(id)
	if switchFn != nil {
		switchFn(id, wss, TransportWSS)
	}
	return nil
}

// switchToUDP 切回 UDP 并关旧 WSS（node.rs:2447-2488）。
func (c *DegradeController) switchToUDP(id NodeID) {
	c.mu.Lock()
	p := c.peers[id]
	if p == nil || p.activeKind != TransportWSS {
		c.mu.Unlock()
		return
	}
	p.activeKind = TransportUDP
	oldWss := p.wssLink
	p.wssLink = nil
	switchFn := c.switchFn
	closeWssFn := c.closeWssFn
	c.mu.Unlock()

	c.policy.BeginCooldown(id)
	if switchFn != nil {
		switchFn(id, nil, TransportUDP)
	} // nil = 恢复 UDP link（由 Lifecycle 处理）
	if oldWss != nil {
		_ = oldWss.Close()
	}
	if closeWssFn != nil {
		closeWssFn(id)
	}
}

// PolicyCounters 返回判定计数器（诊断用）。
func (c *DegradeController) PolicyCounters(id NodeID) (bad, good, cooldown uint32) {
	return c.policy.Counters(id)
}

// Kind 返回某 peer 当前档位（诊断用）。
func (c *DegradeController) Kind(id NodeID) TransportKind {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p := c.peers[id]; p != nil {
		return p.activeKind
	}
	return TransportUDP
}
