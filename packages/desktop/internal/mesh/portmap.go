package mesh

// 路由器端口映射（W4）：把本机 UDP 监听端口映射到公网，供 NAT 后的对端直连。
//
// 三种协议各司其职，按优先级尝试，第一家成功即停止：
//   - NAT-PMP（RFC 6886）：家用路由最常见，UDP 网关:5351，编码简单；
//   - PCP（RFC 6885）：NAT-PMP 的继任者，同端口，IPv6 友好；
//   - UPnP IGD：SSDP 发现 + SOAP，兼容只有 UPnP 的老路由器。
//
// 明确不做的事：不做 DMZ、不猜测外部端口冲突、不静默重试到刷爆路由器 ——
// 失败只记计数与最近一次错误，绝不阻断组网（打洞/中继仍是主通路）。

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

const (
	// natpmpPort 是 NAT-PMP / PCP 的约定端口（RFC 6886 §3）。
	natpmpPort = 5351
	// portMapLifetime 是向外申请的映射寿命；路由器可下调（响应里带回真实值）。
	portMapLifetime = 2 * time.Hour
	// portMapRenewFraction 续约点：寿命的 3/4 处续，留出一次失败重试的余量。
	portMapRenewFraction = 3.0 / 4.0
	// portMapMinRenew 是最短续约间隔，防止路由器回一个极短寿命把循环打爆。
	portMapMinRenew = 30 * time.Second
	// portMapRetry 是「一轮全部协议失败」后的重试间隔上限。
	portMapRetryMax = 5 * time.Minute
	portMapRetryMin = 30 * time.Second
)

// portMapping 是一次成功的映射。
type portMapping struct {
	Protocol     string
	Gateway      string
	ExternalIP   net.IP
	ExternalPort uint16
	InternalPort uint16
	Lifetime     time.Duration
	ExpiresAt    time.Time
}

// portMapRequest 是申请映射的入参。
type portMapRequest struct {
	InternalIP   net.IP
	InternalPort uint16
	Lifetime     time.Duration
}

// portMapClient 是一种映射协议的客户端。
type portMapClient interface {
	protocol() string
	Map(ctx context.Context, req portMapRequest) (*portMapping, error)
}

// PortMapStatus 是端口映射面板快照。
type PortMapStatus struct {
	Enabled      bool   `json:"enabled"`
	Protocol     string `json:"protocol,omitempty"`
	Gateway      string `json:"gateway,omitempty"`
	ExternalIP   string `json:"externalIp,omitempty"`
	ExternalPort uint16 `json:"externalPort,omitempty"`
	InternalPort uint16 `json:"internalPort,omitempty"`
	LifetimeSec  int    `json:"lifetimeSec,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
	Successes    uint64 `json:"successes"`
	Failures     uint64 `json:"failures"`
	LastError    string `json:"lastError,omitempty"`
}

// portMapConfig 是管理器构造参数。
type portMapConfig struct {
	InternalPort uint16
	InternalIP   net.IP
	Lifetime     time.Duration
	// Gateway 非空时跳过网关探测（NAT-PMP/PCP 用）；UPnP 仍走 SSDP。
	Gateway string
	// build 生产环境为 nil（用内置探测）；测试注入固定客户端列表。
	build func(ctx context.Context) []portMapClient
	now   func() time.Time
}

// portMapManager 负责「首次映射 + 到期续约 + 失败退避」。
type portMapManager struct {
	cfg portMapConfig

	mu       sync.Mutex
	clients  []portMapClient
	cur      *portMapping
	success  uint64
	failures uint64
	lastErr  string

	stop chan struct{}
	done chan struct{}
}

func newPortMapManager(cfg portMapConfig) *portMapManager {
	if cfg.Lifetime <= 0 {
		cfg.Lifetime = portMapLifetime
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	return &portMapManager{cfg: cfg, stop: make(chan struct{}), done: make(chan struct{})}
}

// Start 启动后台循环（非阻塞）。
func (p *portMapManager) Start() {
	go p.run()
}

// Stop 停止后台循环并等待退出。
func (p *portMapManager) Stop() {
	close(p.stop)
	<-p.done
}

// Status 返回当前快照。
func (p *portMapManager) Status() PortMapStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := PortMapStatus{
		Enabled:      true,
		InternalPort: p.cfg.InternalPort,
		Successes:    p.success,
		Failures:     p.failures,
		LastError:    p.lastErr,
	}
	if p.cur != nil {
		st.Protocol = p.cur.Protocol
		st.Gateway = p.cur.Gateway
		if p.cur.ExternalIP != nil {
			st.ExternalIP = p.cur.ExternalIP.String()
		}
		st.ExternalPort = p.cur.ExternalPort
		st.InternalPort = p.cur.InternalPort
		st.LifetimeSec = int(p.cur.Lifetime.Seconds())
		if !p.cur.ExpiresAt.IsZero() {
			st.ExpiresAt = p.cur.ExpiresAt.UTC().Format(time.RFC3339)
		}
	}
	return st
}

func (p *portMapManager) run() {
	defer close(p.done)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		p.refresh(ctx)
		cancel()
		if !sleepOrStop(p.stop, p.nextDelay()) {
			return
		}
	}
}

// nextDelay 决定下一次尝试时刻：已映射则等着续约，否则指数退避。
func (p *portMapManager) nextDelay() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cur != nil {
		life := p.cur.Lifetime
		if life <= 0 {
			life = p.cfg.Lifetime
		}
		d := time.Duration(float64(life) * portMapRenewFraction)
		if d < portMapMinRenew {
			d = portMapMinRenew
		}
		return d
	}
	// 首次失败等 30s，之后每失败一轮翻倍（上限 5min）。
	shift := uint64(0)
	if p.failures > 0 {
		shift = p.failures - 1
	}
	d := portMapRetryMin << minInt(shift, 4)
	if d > portMapRetryMax || d <= 0 {
		d = portMapRetryMax
	}
	return d
}

// refresh 按优先级尝试所有协议，第一家成功即写回当前映射。
func (p *portMapManager) refresh(ctx context.Context) {
	p.mu.Lock()
	clients := p.clients
	p.mu.Unlock()
	if len(clients) == 0 {
		clients = p.buildClients(ctx)
		p.mu.Lock()
		p.clients = clients
		p.mu.Unlock()
	}
	req := portMapRequest{
		InternalIP:   p.cfg.InternalIP,
		InternalPort: p.cfg.InternalPort,
		Lifetime:     p.cfg.Lifetime,
	}
	var lastErr error
	for _, c := range clients {
		m, err := c.Map(ctx, req)
		if err != nil {
			lastErr = fmt.Errorf("%s: %w", c.protocol(), err)
			continue
		}
		if m.InternalPort == 0 {
			m.InternalPort = p.cfg.InternalPort
		}
		if m.ExpiresAt.IsZero() {
			life := m.Lifetime
			if life <= 0 {
				life = p.cfg.Lifetime
			}
			m.ExpiresAt = p.cfg.now().Add(life)
		}
		p.mu.Lock()
		first := p.cur == nil
		p.cur = m
		p.success++
		p.lastErr = ""
		p.mu.Unlock()
		if first {
			log.Printf("[mesh] 端口映射成功: %s %s -> %s:%d（寿命 %s）",
				m.Protocol, m.Gateway, m.ExternalIP, m.ExternalPort, m.Lifetime)
		}
		return
	}
	p.mu.Lock()
	p.failures++
	if lastErr != nil {
		p.lastErr = lastErr.Error()
	}
	p.mu.Unlock()
}

// buildClients 探测网关并构造协议客户端（按优先级）。
func (p *portMapManager) buildClients(ctx context.Context) []portMapClient {
	if p.cfg.build != nil {
		return p.cfg.build(ctx)
	}
	var out []portMapClient
	var gw net.IP
	if p.cfg.Gateway != "" {
		if ip := net.ParseIP(p.cfg.Gateway); ip != nil {
			gw = ip
		}
	} else {
		gw = discoverNATPMPGateway(ctx, gatewayCandidates())
	}
	if gw != nil {
		server := net.JoinHostPort(gw.String(), fmt.Sprint(natpmpPort))
		out = append(out, &natpmpClient{server: server})
		out = append(out, &pcpClient{server: server, clientIP: p.cfg.InternalIP})
	}
	// UPnP 永远兜底：不依赖网关地址，只依赖路由器开着 IGD。
	if dev, err := discoverUPnPDevice(ctx, p.cfg.InternalIP); err == nil {
		out = append(out, dev)
	} else if len(out) == 0 {
		log.Printf("[mesh] 端口映射不可用: %v", err)
	}
	return out
}

// gatewayCandidates 由本机 IPv4 网卡推出「可能是网关」的候选地址。
//
// 不读系统路由表（三平台各一套 API，还得处理多默认路由），而是让 NAT-PMP 的
// GetExternalAddress 去回答「谁是真网关」—— 这本来就是该协议的用途，且零平台依赖。
func gatewayCandidates() []net.IP {
	var out []net.IP
	seen := map[string]bool{}
	add := func(ip net.IP) {
		if ip == nil || ip.IsLoopback() || ip.To4() == nil {
			return
		}
		if seen[ip.String()] {
			return
		}
		seen[ip.String()] = true
		out = append(out, ip)
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, ifi := range ifaces {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 == nil {
				continue
			}
			base := ip4.Mask(ipn.Mask)
			for _, host := range []byte{1, 254} {
				cand := make(net.IP, 4)
				copy(cand, base)
				cand[3] = host
				add(cand)
			}
		}
	}
	return out
}

// discoverNATPMPGateway 并发探候选网关（NAT-PMP GetExternalAddress，opcode 0）。
func discoverNATPMPGateway(ctx context.Context, candidates []net.IP) net.IP {
	if len(candidates) == 0 {
		return nil
	}
	type result struct{ gw net.IP }
	ch := make(chan net.IP, len(candidates))
	for _, ip := range candidates {
		go func(ip net.IP) {
			c := &natpmpClient{server: net.JoinHostPort(ip.String(), fmt.Sprint(natpmpPort))}
			if _, err := c.externalAddress(ctx); err == nil {
				ch <- ip
				return
			}
			ch <- nil
		}(ip)
	}
	for range candidates {
		if ip := <-ch; ip != nil {
			return ip
		}
	}
	return nil
}

// localIPv4For 返回「朝 gw 发包时会用的本机 IPv4」（网关未知时取第一个私网地址）。
func localIPv4For(gw net.IP) net.IP {
	if gw != nil {
		conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: gw, Port: natpmpPort})
		if err == nil {
			ip := conn.LocalAddr().(*net.UDPAddr).IP.To4()
			_ = conn.Close()
			if ip != nil {
				return ip
			}
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, ifi := range ifaces {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifi.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			if ip4 := ipn.IP.To4(); ip4 != nil && ip4.IsPrivate() {
				return ip4
			}
		}
	}
	return nil
}

func sleepOrStop(stop <-chan struct{}, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-stop:
		return false
	case <-t.C:
		return true
	}
}

func minInt(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}
