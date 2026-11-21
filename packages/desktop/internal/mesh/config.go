package mesh

import (
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/flynn/noise"
)

// Config 是 +mesh 节点的启动配置（桌面版/CLI 构造后注入 Lifecycle）。
//
// 字段对齐 MobiHop 的 node.toml 最小集：
//   - NodeID / NetworkName / PSK / TunnelKey → 身份与加密
//   - Listen → UDP 监听地址（UdpHub 单 socket）
//   - VirtualIP / MTU → TUN 设备
//   - Peers → 静态对端（seed）：NodeID + UDP 地址 + X25519 静态公钥
type Config struct {
	NodeID      NodeID
	NetworkName string
	PSK         string
	// TunnelPrivate 是 X25519 隧道静态私钥（32 字节原始字节）；留空则随机生成
	TunnelPrivate []byte
	// IdentitySeed 是 Ed25519 身份私钥种子（32 字节原始字节），用于描述符签名。
	// 由面板从本地身份传入；留空则用 TunnelPrivate 派生（兼容旧配置/CLI）。
	IdentitySeed []byte
	Listen       string // UDP 监听，如 "0.0.0.0:51820"
	// DisableListenDual 关闭双栈监听（默认 false = 开启）。
	//
	// 具体行为：`Listen` 是未指定地址（0.0.0.0 / :: / 空）时优先绑 `[::]:port`
	// 并显式关闭 IPV6_V6ONLY，一个 socket 同时收 IPv4 与 IPv6；
	// 绑失败则回退到配置地址。`Listen` 写具体 IP 时本项无效。
	DisableListenDual bool
	// PublicAddr 是手工声明的外网地址（`ip:port`），用于路由器端口映射 / DMZ /
	// 公网 IPv6 这类「STUN 看不准但确实可达」的场景。填了就按**固定端口**
	// 注入候选并排在候选表最前（不按偏移展开、不参与端口校准）。
	// 留空 = 完全按 STUN/网卡推导。
	PublicAddr string
	VirtualIP  string // 本节点虚拟 IP，如 "10.93.0.1"
	MTU        int    // TUN MTU，默认 1400
	Peers      []PeerConfig
	// Verbose 打开关键节点日志（通过 log.Printf 输出）。
	Verbose bool
	// RelayDomain / RelayRoom 是盲中继 WSS 地址（降级目标）；留空则禁用降级。
	RelayDomain string // 如 relay.example.com
	RelayRoom   string // 8-64 位小写 hex（房间名）
	// RelayConnectIP 是 WSS 盲中继的**优选入口 IP**（可选）。
	// 填了就连这个 IP，TLS SNI / HTTP Host 仍是 RelayDomain ——
	// 用来避开被污染的域名解析、或换到延迟更低的 Cloudflare 边缘 IP。
	// 留空 = 按域名解析（行为与之前一致）。
	RelayConnectIP string
	// EnableDegrade 打开 UDP→WSS 降级 / WSS→UDP 回切控制器。
	EnableDegrade bool
	// DisablePunch 关闭打洞升级（默认 false=启用）。
	// 只在「会话经中继建立」时尝试：直连本来可用就不会触发。
	DisablePunch bool

	// ---- 专用服务器中继（兜底，对齐 MobiHop [[relays]] + mobihop-relay）----
	//
	// 与「盲中继 WSS」不同：这是**有准入令牌的专用 UDP 中继**（如部署在阿里云 ECS 的
	// mobihop-relay），节点启动后向它注册并维持心跳，直连不可达时经它转发密文。
	// 注册只上传 BLAKE3(token) 摘要，令牌原文不落盘、不进日志。
	// 留空/条目不完整则不启用。
	RelayServers []RelayServerConfig
	// TunName 是 TUN 设备名（多节点同机时必须不同）；留空 = cfpilot0。
	TunName string

	// ---- 云监测台上报（对齐 MobiHop node/monitor.rs）----
	//
	// 仅在 MonitoringEndpoint + MonitoringToken 都非空时启用；留空=完全不上报。
	// 每 MonitoringIntervalMS 周期 POST <endpoint>/heartbeat（默认 30s，最低 5s），
	// 失败只记日志、绝不阻断组网；令牌不进日志。
	MonitoringEndpoint string
	MonitoringToken    string
	// MonitoringIntervalMS 上报间隔（毫秒）；<=0 用默认 30000，低于 5000 按 5000。
	MonitoringIntervalMS int64
	// MonitoringAlias 监测台显示名；留空用主机名。
	MonitoringAlias string
	// ClientVersion 上报给监测台的客户端版本；留空由 meshd/移动端填。
	ClientVersion string

	// ---- 跨 NAT：STUN 探测（对齐 MobiHop stun.rs）----
	// StunServers 是公共 STUN 服务器池（host:port）。nil = 用默认四家；
	// **显式空数组 = 关闭主动探测**（与 MobiHop 语义一致）。
	StunServers []string
	// StunProbeTimeoutMS 单轮探测超时（毫秒，默认 1500，范围 100..30000）。
	StunProbeTimeoutMS int64
}

// PeerConfig 是静态对端（seed）配置。
// RelayServerConfig 是一台专用中继服务器的接入参数（对齐 MobiHop [[relays]]）。
type RelayServerConfig struct {
	NodeID string // 中继节点 ID（16 hex）
	Addr   string // 中继 UDP 地址，如 203.0.113.10:51830
	Token  string // 准入令牌（只用于计算 BLAKE3 摘要，不写日志/不落盘）
	// Blind 表示这是**零知识公共盲中继**（`mobihop-relay --relay-only`）：
	// 按 PSK 派生的 `room_tag` 分房，不需要令牌（Token 可留空）。
	Blind bool
}
type PeerConfig struct {
	NodeID    NodeID
	Addr      string // "host:port"
	StaticPub []byte // X25519 静态公钥（32 字节）；IK 握手需预知
	VirtualIP string // 对端虚拟 IP（如 "10.96.0.2"），用于 IP 包→NodeID 查表
	Name      string `json:"name,omitempty"` // 设备名/别名，仅用于面板展示
}

// ParsePublicAddr 解析 `public_addr`，同时接受 `1.2.3.4:51820`、`[240e::1]:51820`
// 与**裸 IPv6 带端口** `240e::1:51820`。
//
// 裸 IPv6 是用户最常见的写法：直接交给 `net.SplitHostPort` 会报
// "too many colons"，于是看似合法的配置被拒（真机踩到）。这里按最后一个冒号切。
func ParsePublicAddr(raw string) (*net.UDPAddr, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, fmt.Errorf("mesh config: PublicAddr 为空")
	}
	host, portStr, err := net.SplitHostPort(s)
	if err != nil {
		// 再试一次；ip:port 形式（含裸 IPv6）用最后一个冒号切
		if i := strings.LastIndex(s, ":"); i > 0 {
			host, portStr = s[:i], s[i+1:]
		} else {
			return nil, fmt.Errorf("mesh config: PublicAddr 需为 ip:port: %w", err)
		}
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return nil, fmt.Errorf("mesh config: PublicAddr 不是合法 IP: %s", host)
	}
	port, perr := strconv.Atoi(portStr)
	if perr != nil || port <= 0 || port > 65535 {
		return nil, fmt.Errorf("mesh config: PublicAddr 端口非法: %s", portStr)
	}
	return &net.UDPAddr{IP: ip, Port: port}, nil
}

// Validate 校验配置（fail-closed）。
func (c *Config) Validate() error {
	if c.NetworkName == "" {
		return fmt.Errorf("mesh config: NetworkName 不能为空")
	}
	if len(c.PSK) == 0 {
		return fmt.Errorf("mesh config: PSK 不能为空")
	}
	if c.Listen == "" {
		c.Listen = "0.0.0.0:51820"
	}
	if c.VirtualIP == "" {
		return fmt.Errorf("mesh config: VirtualIP 不能为空")
	}
	if net.ParseIP(c.VirtualIP) == nil {
		return fmt.Errorf("mesh config: VirtualIP 非法: %s", c.VirtualIP)
	}
	if c.MTU <= 0 {
		c.MTU = 1400
	}
	// public_addr：必须是「非回环 / 非私网 / 非链路本地 / 端口非 0」的 ip:port，
	// 否则写进候选池只会制造假希望（MobiHop validate_public_addr 同款约束）。
	if c.PublicAddr != "" {
		addr, err := ParsePublicAddr(c.PublicAddr)
		if err != nil {
			return err
		}
		if addr.Port == 0 {
			return fmt.Errorf("mesh config: PublicAddr 端口不能为 0")
		}
		switch {
		case addr.IP == nil:
			return fmt.Errorf("mesh config: PublicAddr 必须是 ip:port")
		case addr.IP.IsLoopback():
			return fmt.Errorf("mesh config: PublicAddr 不能是回环地址: %s", c.PublicAddr)
		case addr.IP.IsPrivate():
			return fmt.Errorf("mesh config: PublicAddr 不能是私网地址: %s", c.PublicAddr)
		case addr.IP.IsLinkLocalUnicast():
			return fmt.Errorf("mesh config: PublicAddr 不能是链路本地地址: %s", c.PublicAddr)
		default:
			if v4 := addr.IP.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
				return fmt.Errorf("mesh config: PublicAddr 不能是运营商 CGNAT 地址（100.64.0.0/10）: %s", c.PublicAddr)
			}
		}
	}
	// STUN：nil 用默认池；显式空数组表示关闭探测。
	if c.StunServers == nil {
		c.StunServers = append([]string(nil), DefaultStunServers...)
	}
	if c.StunProbeTimeoutMS <= 0 {
		c.StunProbeTimeoutMS = DefaultStunProbeMS
	}
	if c.StunProbeTimeoutMS < MinStunProbeMS {
		c.StunProbeTimeoutMS = MinStunProbeMS
	}
	if c.StunProbeTimeoutMS > MaxStunProbeMS {
		c.StunProbeTimeoutMS = MaxStunProbeMS
	}

	// 云监测台上报间隔归一化（对齐 MobiHop：默认 30s、最低 5s）
	if c.MonitoringIntervalMS <= 0 {
		c.MonitoringIntervalMS = DefaultMonitorIntervalMS
	}
	if c.MonitoringIntervalMS < MinMonitorIntervalMS {
		c.MonitoringIntervalMS = MinMonitorIntervalMS
	}
	if len(c.TunnelPrivate) > 0 && len(c.TunnelPrivate) != 32 {
		return fmt.Errorf("mesh config: TunnelPrivate 必须 32 字节，实际 %d", len(c.TunnelPrivate))
	}
	if len(c.IdentitySeed) > 0 && len(c.IdentitySeed) != 32 {
		return fmt.Errorf("mesh config: IdentitySeed 必须 32 字节，实际 %d", len(c.IdentitySeed))
	}
	// 专用中继条目：NodeID 必须是 16 hex，Addr 必须是 host:port；token 可空（盲中继除外）
	for i, r := range c.RelayServers {
		if r.Addr == "" {
			return fmt.Errorf("mesh config: RelayServers[%d].Addr 为空", i)
		}
		if _, _, err := net.SplitHostPort(r.Addr); err != nil {
			return fmt.Errorf("mesh config: RelayServers[%d].Addr 非法: %w", i, err)
		}
		if r.NodeID != "" {
			if _, err := ParseNodeIDHex(r.NodeID); err != nil {
				return fmt.Errorf("mesh config: RelayServers[%d].NodeID 非法: %w", i, err)
			}
		}
		// 盲中继不需要令牌（按 room_tag 分房）；令牌中继必须给令牌，
		// 否则线上只发空摘要，中继会判 AuthReject 而用户看不出原因。
		if !r.Blind && r.Token == "" {
			return fmt.Errorf("mesh config: RelayServers[%d] 既非 blind 又缺 token", i)
		}
	}
	for i, p := range c.Peers {
		if p.Addr == "" {
			return fmt.Errorf("mesh config: Peers[%d].Addr 为空", i)
		}
		if _, _, err := net.SplitHostPort(p.Addr); err != nil {
			return fmt.Errorf("mesh config: Peers[%d].Addr 非法: %w", i, err)
		}
		if len(p.StaticPub) != 32 {
			return fmt.Errorf("mesh config: Peers[%d].StaticPub 必须 32 字节，实际 %d", i, len(p.StaticPub))
		}
		if net.ParseIP(p.VirtualIP) == nil {
			return fmt.Errorf("mesh config: Peers[%d].VirtualIP 非法: %s", i, p.VirtualIP)
		}
	}
	return nil
}

// tunnelKey 返回本节点的 X25519 静态密钥对。
func (c *Config) tunnelKey() (noise.DHKey, error) {
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	if len(c.TunnelPrivate) == 32 {
		// 从私钥恢复公钥：用 x25519 标量乘（noise 不直接暴露，这里用 DHKey 的 Private
		// 配合首次 WriteMessage 生成——但响应方需要 Public，故用 x/crypto/curve25519 计算）
		pub, err := curve25519Public(c.TunnelPrivate)
		if err != nil {
			return noise.DHKey{}, err
		}
		return noise.DHKey{Private: append([]byte(nil), c.TunnelPrivate...), Public: pub}, nil
	}
	// 随机生成
	return cs.GenerateKeypair(nil)
}
