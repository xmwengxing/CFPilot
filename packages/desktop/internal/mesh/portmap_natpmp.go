package mesh

// NAT-PMP（RFC 6886）与 PCP（RFC 6885）客户端。
//
// 两者都在 UDP 网关:5351 上，报文都是定长大端；PCP 只是把地址换成 16 字节
// 并加了一个 12 字节 nonce。写死字节偏移是本文件的主要工作 ——
// 错一个字节路由器就静默不回，所以每个偏移都有单测。

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"
)

const portMapProbeTimeout = 800 * time.Millisecond

// ---------- NAT-PMP ----------

type natpmpClient struct {
	server  string // host:port
	timeout time.Duration
}

func (c *natpmpClient) protocol() string { return "nat-pmp" }

func (c *natpmpClient) deadline() time.Duration {
	if c.timeout > 0 {
		return c.timeout
	}
	return portMapProbeTimeout
}

func (c *natpmpClient) roundTrip(ctx context.Context, req []byte, minLen int) ([]byte, error) {
	d := net.Dialer{Timeout: c.deadline()}
	conn, err := d.DialContext(ctx, "udp4", c.server)
	if err != nil {
		return nil, fmt.Errorf("连接网关失败: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(c.deadline()))
	if _, err := conn.Write(req); err != nil {
		return nil, fmt.Errorf("发送请求失败: %w", err)
	}
	buf := make([]byte, 64)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("读响应失败: %w", err)
	}
	if n < minLen {
		return nil, fmt.Errorf("响应过短 %d < %d", n, minLen)
	}
	return buf[:n], nil
}

// externalAddress 发 opcode 0（GetExternalAddress），NAT-PMP 用它做网关探测。
func (c *natpmpClient) externalAddress(ctx context.Context) (net.IP, error) {
	resp, err := c.roundTrip(ctx, []byte{0, 0}, 12)
	if err != nil {
		return nil, err
	}
	if resp[0] != 0 || resp[1] != 128 {
		return nil, fmt.Errorf("响应头不符 % x", resp[:2])
	}
	if res := binary.BigEndian.Uint16(resp[2:4]); res != 0 {
		return nil, fmt.Errorf("网关拒绝: %s", natpmpResultText(res))
	}
	ip := net.IPv4(resp[8], resp[9], resp[10], resp[11]).To4()
	if ip == nil || ip.IsUnspecified() {
		return nil, fmt.Errorf("网关未返回外部地址")
	}
	return ip, nil
}

func (c *natpmpClient) Map(ctx context.Context, req portMapRequest) (*portMapping, error) {
	life := uint32(req.Lifetime / time.Second)
	pkt := make([]byte, 12)
	pkt[0] = 0 // 版本
	pkt[1] = 0 // opcode 0 = UDP
	// [2:4] 保留
	binary.BigEndian.PutUint16(pkt[4:6], req.InternalPort)
	binary.BigEndian.PutUint16(pkt[6:8], req.InternalPort) // 建议外部端口 = 内部端口
	binary.BigEndian.PutUint32(pkt[8:12], life)
	resp, err := c.roundTrip(ctx, pkt, 16)
	if err != nil {
		return nil, err
	}
	if resp[0] != 0 || resp[1] != 128 {
		return nil, fmt.Errorf("响应头不符 % x", resp[:2])
	}
	if res := binary.BigEndian.Uint16(resp[2:4]); res != 0 {
		return nil, fmt.Errorf("网关拒绝: %s", natpmpResultText(res))
	}
	if got := binary.BigEndian.Uint16(resp[8:10]); got != req.InternalPort {
		return nil, fmt.Errorf("内部端口不符 %d != %d", got, req.InternalPort)
	}
	extPort := binary.BigEndian.Uint16(resp[10:12])
	granted := time.Duration(binary.BigEndian.Uint32(resp[12:16])) * time.Second
	if extPort == 0 || granted == 0 {
		return nil, fmt.Errorf("映射为空（网关拒绝或寿命为 0）")
	}
	// NAT-PMP 的 MAP 响应**不含外部 IP**（只有端口），另发一次
	// GetExternalAddress 补齐；补不到就留空，不影响映射本身可用。
	extIP, _ := c.externalAddress(ctx)
	return &portMapping{
		Protocol:     c.protocol(),
		Gateway:      c.server,
		ExternalIP:   extIP,
		ExternalPort: extPort,
		InternalPort: req.InternalPort,
		Lifetime:     granted,
		ExpiresAt:    time.Now().Add(granted),
	}, nil
}

func natpmpResultText(code uint16) string {
	switch code {
	case 1:
		return "不支持该版本"
	case 2:
		return "未授权/被拒绝"
	case 3:
		return "网络故障"
	case 4:
		return "资源不足"
	case 5:
		return "不支持该操作"
	}
	return fmt.Sprintf("结果码 %d", code)
}

// ---------- PCP ----------

type pcpClient struct {
	server   string
	clientIP net.IP
	timeout  time.Duration
}

func (c *pcpClient) protocol() string { return "pcp" }

func (c *pcpClient) deadline() time.Duration {
	if c.timeout > 0 {
		return c.timeout
	}
	return portMapProbeTimeout
}

const (
	pcpVersion = 2
	pcpOpMap   = 1
	pcpHeader  = 24
	pcpMapBody = 36
)

func (c *pcpClient) Map(ctx context.Context, req portMapRequest) (*portMapping, error) {
	clientIP := req.InternalIP
	if clientIP == nil {
		clientIP = c.clientIP
	}
	v16 := ipv4Mapped(clientIP)
	if v16 == nil {
		return nil, fmt.Errorf("没有可用的本机 IPv4")
	}
	life := uint32(req.Lifetime / time.Second)
	pkt := make([]byte, pcpHeader+pcpMapBody)
	pkt[0] = pcpVersion
	pkt[1] = pcpOpMap
	binary.BigEndian.PutUint32(pkt[4:8], life)
	copy(pkt[8:24], v16)
	var nonce [12]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		return nil, fmt.Errorf("生成 nonce 失败: %w", err)
	}
	copy(pkt[24:36], nonce[:])
	pkt[36] = 17 // UDP
	binary.BigEndian.PutUint16(pkt[40:42], req.InternalPort)
	binary.BigEndian.PutUint16(pkt[42:44], req.InternalPort)
	copy(pkt[44:60], v16)

	d := net.Dialer{Timeout: c.deadline()}
	conn, err := d.DialContext(ctx, "udp4", c.server)
	if err != nil {
		return nil, fmt.Errorf("连接网关失败: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(c.deadline()))
	if _, err := conn.Write(pkt); err != nil {
		return nil, fmt.Errorf("发送请求失败: %w", err)
	}
	resp := make([]byte, 128)
	n, err := conn.Read(resp)
	if err != nil {
		return nil, fmt.Errorf("读响应失败: %w", err)
	}
	if n < pcpHeader+pcpMapBody {
		return nil, fmt.Errorf("响应过短 %d", n)
	}
	resp = resp[:n]
	if resp[0] != pcpVersion || resp[1] != 0x80|pcpOpMap {
		return nil, fmt.Errorf("响应头不符 % x", resp[:2])
	}
	if code := resp[8]; code != 0 {
		return nil, fmt.Errorf("网关拒绝: %s", pcpResultText(code))
	}
	if !equalBytes(resp[24:36], nonce[:]) {
		return nil, fmt.Errorf("nonce 不匹配（响应可能来自别的请求）")
	}
	if got := binary.BigEndian.Uint16(resp[40:42]); got != req.InternalPort {
		return nil, fmt.Errorf("内部端口不符 %d != %d", got, req.InternalPort)
	}
	extPort := binary.BigEndian.Uint16(resp[42:44])
	granted := time.Duration(binary.BigEndian.Uint32(resp[4:8])) * time.Second
	if extPort == 0 || granted == 0 {
		return nil, fmt.Errorf("映射为空（网关拒绝或寿命为 0）")
	}
	extIP := net.IP(append([]byte(nil), resp[44:60]...))
	return &portMapping{
		Protocol:     c.protocol(),
		Gateway:      c.server,
		ExternalIP:   extIP.To4(),
		ExternalPort: extPort,
		InternalPort: req.InternalPort,
		Lifetime:     granted,
		ExpiresAt:    time.Now().Add(granted),
	}, nil
}

func pcpResultText(code byte) string {
	switch code {
	case 1:
		return "不支持该版本"
	case 2:
		return "未授权"
	case 3:
		return "请求格式错误"
	case 4:
		return "不支持该操作"
	case 5:
		return "寿命过长"
	case 6:
		return "内部地址不支持"
	case 7:
		return "地址族不支持"
	case 8:
		return "资源不足"
	}
	return fmt.Sprintf("结果码 %d", code)
}

// ipv4Mapped 把 IPv4 转成 16 字节 v4-in-v6 形式（PCP 报文要求）。
func ipv4Mapped(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		out := make(net.IP, 16)
		out[10], out[11] = 0xff, 0xff
		copy(out[12:], v4)
		return out
	}
	return nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
