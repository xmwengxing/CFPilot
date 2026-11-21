package mesh

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// 邀请链接（对齐 MobiHop mobihop://join/v1/<base64url(JSON)>，invite.rs:24-55）。
// 用 CFPilot 自己的 scheme 以便区分。
const InviteURIPrefix = "cfpilot-mesh://join/v1/"

// InvitePayload 是邀请链接载荷：发起方把「网络参数 + 自己作为一个 peer」编码进去，
// 对端 join 后自动填入，无需手抄 16hex ID / 64hex 公钥。
type InvitePayload struct {
	V         uint8  `json:"v"`
	Network   string `json:"network"`
	PSK       string `json:"psk"`
	Addr      string `json:"addr"`                // 发起方可达的 IP:端口
	NodeID    string `json:"node_id"`             // 发起方 NodeId（16 hex）
	TunnelPub string `json:"tunnel_pub"`          // 发起方 X25519 静态公钥（64 hex）
	VirtualIP string `json:"virtual_ip"`          // 发起方虚拟 IP
	Suggested string `json:"suggested,omitempty"` // 建议对端虚拟 IP
	Exp       int64  `json:"exp,omitempty"`       // 过期时间 Unix 秒，0=永久
	// Alias 是发起方设备名（监测台 alias / 主机名），让加入方节点列表能显示对端设备名。
	Alias string `json:"alias,omitempty"`

	// 云监测台上报参数（可选）：让被邀请方入网后**自动上报**，
	// 不必再手工抄 Worker 地址与令牌。
	// 注意：这与 PSK 同属敏感信息（令牌泄露 = 他人可伪造上报），
	// 所以和 PSK 一样只 base64、明文警示勿公开分享。
	MonitorEndpoint   string `json:"monitoring_endpoint,omitempty"`
	MonitorToken      string `json:"monitoring_token,omitempty"`
	MonitorIntervalMS int64  `json:"monitoring_interval_ms,omitempty"`
	MonitorAlias      string `json:"monitor_alias,omitempty"`

	// 盲中继配置（可选）：跨 NAT 时对端需要知道同一条中继与房间，
	// 否则只能直连。邀请链接一并带上，B 无需手抄。
	RelayDomain    string `json:"relay_domain,omitempty"`
	RelayRoom      string `json:"relay_room,omitempty"`
	RelayConnectIP string `json:"relay_connect_ip,omitempty"`
}

// ReachableListenAddr 把「监听地址」换成对端**可直连**的地址。
//
// 邀请链接里的 addr 如果照抄面板默认的 `0.0.0.0:51820`，对端根本连不上
// 0.0.0.0（UDP 发往通配地址会被丢弃），表现为「握手一直不成功」。
// 这里在生链接时换成本机真实网卡地址：优先全球 IPv6（免 NAT），再选物理
// 网卡的私网 IPv4；EasyTier / TUN / 虚拟网卡必须排除，否则会把虚拟 IP
// 当对端地址发出去，形成隧道自环。
//
// 返回原值时说明没有做替换（要么本来就可直连，要么找不到可用网卡）。
func ReachableListenAddr(listen string) string {
	trimmed := strings.TrimSpace(listen)
	if trimmed == "" {
		trimmed = "0.0.0.0:51820"
	}
	host, port, err := net.SplitHostPort(trimmed)
	if err != nil {
		return listen
	}
	if host != "" && net.ParseIP(host) != nil && !isWildcardHost(host) {
		return trimmed // 已是具体地址，尊重用户填写
	}
	if port == "" {
		port = "51820"
	}
	ips := reachableInterfaceIPs()
	var physicalV4 string
	for _, ip := range ips {
		if !reachableInterface(ip) {
			continue
		}
		if ip.To4() == nil {
			return net.JoinHostPort(ip.String(), port)
		}
		if physicalV4 == "" {
			physicalV4 = ip.String()
		}
	}
	if physicalV4 != "" {
		return net.JoinHostPort(physicalV4, port)
	}
	return listen
}

func isWildcardHost(host string) bool {
	ip := net.ParseIP(host)
	return ip == nil || ip.IsUnspecified()
}

// reachableInterface 排除不能作为 UDP 对端地址的地址类型。
func reachableInterface(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		// 100.64.0.0/10 是运营商 CGNAT，不可作为对端地址。
		if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
			return false
		}
	}
	return true
}

// reachableInterfaceName 排除常见虚拟网卡 / TUN / VPN 接口（Windows / Linux / macOS）。
func reachableInterfaceName(name string) bool {
	lower := strings.ToLower(name)
	for _, prefix := range []string{
		"cfpilot", "mobihop", "easytier", "tap", "tun", "wintun", "wsl", "veth",
		"vmnet", "virtualbox", "vmware", "hyper-v", "vswitch", "docker", "lo", "utun",
	} {
		if strings.HasPrefix(lower, prefix) {
			return false
		}
	}
	return true
}

// reachableInterfaceIPs 按接口逐个收集可用地址，供邀请生成时排除虚拟 NIC。
func reachableInterfaceIPs() []net.IP {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := make([]net.IP, 0, len(ifs))
	for _, iface := range ifs {
		if !reachableInterfaceName(iface.Name) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || !reachableInterface(ipnet.IP) {
				continue
			}
			out = append(out, ipnet.IP)
		}
	}
	return out
}

// localIPv4s 收集本机所有非回环 IPv4（冒烟环境可能为空）。
func localIPv4s() []string {
	out := make([]string, 0, 4)
	for _, ip := range reachableInterfaceIPs() {
		if v4 := ip.To4(); v4 != nil {
			out = append(out, v4.String())
		}
	}
	return out
}

// BuildInvite 生成邀请链接。
// ttlSeconds=0 表示永久；>0 则设置过期时间。
func BuildInvite(p InvitePayload, ttlSeconds int64) (string, error) {
	if strings.TrimSpace(p.Network) == "" || p.PSK == "" {
		return "", fmt.Errorf("生成邀请链接需要网络名与 PSK")
	}
	if strings.TrimSpace(p.Alias) == "" {
		if host, err := os.Hostname(); err == nil {
			p.Alias = strings.TrimSpace(host)
		}
	}
	p.Alias = printableAlias(p.Alias)
	p.V = 1
	// 监听地址若是通配（0.0.0.0 / ::），换成对端能直连的本机 IPv4。
	p.Addr = ReachableListenAddr(p.Addr)
	// 建议对端虚拟 IP：**同一 /24 内顺延最后一段**。
	// 组网要求同网段（TUN 固定 /24 且不给对端加主机路由），
	// 让对端自己填很容易写成另一个网段（如 10.98.0.2），那是最常见的连不上原因。
	if strings.TrimSpace(p.Suggested) == "" {
		if ip := net.ParseIP(strings.TrimSpace(p.VirtualIP)); ip != nil {
			if v4 := ip.To4(); v4 != nil {
				last := int(v4[3]) + 1
				if last > 254 {
					last = 2 // .255 是广播地址，回绕到一个安全值
				}
				p.Suggested = fmt.Sprintf("%d.%d.%d.%d", v4[0], v4[1], v4[2], last)
			}
		}
	}
	if ttlSeconds > 0 {
		p.Exp = time.Now().Unix() + ttlSeconds
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return InviteURIPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func printableAlias(raw string) string {
	var out strings.Builder
	for _, r := range raw {
		if r < 32 || r == 127 || r == 0xfffd {
			continue
		}
		out.WriteRune(r)
	}
	return strings.TrimSpace(out.String())
}

// ParseInvite 解析并校验邀请链接。
func ParseInvite(uri string) (*InvitePayload, error) {
	if !strings.HasPrefix(uri, InviteURIPrefix) {
		return nil, fmt.Errorf("不是有效的 CFPilot mesh 邀请链接（前缀应为 %s）", InviteURIPrefix)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(uri, InviteURIPrefix))
	if err != nil {
		return nil, fmt.Errorf("邀请链接编码非法: %w", err)
	}
	if len(raw) > 8192 {
		return nil, fmt.Errorf("邀请链接过长")
	}
	var p InvitePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("邀请链接内容非法: %w", err)
	}
	if p.V != 1 {
		return nil, fmt.Errorf("不支持的邀请链接版本 %d", p.V)
	}
	if strings.TrimSpace(p.Network) == "" || p.PSK == "" {
		return nil, fmt.Errorf("邀请链接缺少网络名或 PSK")
	}
	if p.Exp > 0 && time.Now().Unix() >= p.Exp {
		return nil, fmt.Errorf("邀请链接已过期")
	}
	// 校验编码字段
	if p.NodeID != "" {
		if _, err := ParseNodeIDHex(p.NodeID); err != nil {
			return nil, fmt.Errorf("邀请链接里的节点 ID 非法: %w", err)
		}
	}
	return &p, nil
}

// SensitiveWarning 返回邀请链接的敏感提示（PSK 明文在链接里，base64 非加密）。
func SensitiveWarning() string {
	return "邀请链接里包含明文的网络密钥（仅 base64 编码，非加密）。" +
		"泄露=他人可加入你的网络，只能全网轮换 PSK。请勿发到公开群/日志/issue。"
}
