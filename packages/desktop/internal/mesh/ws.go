package mesh

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// WSS 传输层（契约 §6）。
//
// 要点：
//   - 仅接受 wss://（ws:// 拒绝）
//   - connect_ip：TCP 连 connect_ip，TLS SNI / HTTP Host 仍用原域名
//   - 1 WS Binary 消息 = 1 个 32B 头帧（≤1432 字节）
//   - 盲中继房间路由：/mesh/<network_hash>?peer_id=<16hex>

// WsUrl 是解析后的 WSS 地址（契约 §6.1-6.2）。
type WsUrl struct {
	Host      string // 原始域名（SNI / Host 用）
	Port      int    // 默认 443
	Path      string // 保留（盲中继 /mesh/...）
	RawQuery  string // 保留（peer_id）
	ConnectIP string // 可选：TCP 直连 IP（SNI/Host 不变）
}

// ParseWsUrl 解析 wss:// 地址（契约 §6.1，ws.rs:106-125）。
func ParseWsUrl(raw string) (*WsUrl, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("mesh ws: 解析 URL 失败: %w", err)
	}
	if u.Scheme != "wss" {
		return nil, fmt.Errorf("mesh ws: 仅接受 wss://，实际 %q", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("mesh ws: host 为空")
	}
	port := WssDefaultPort
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("mesh ws: 非法端口 %q", p)
		}
		port = n
	}
	return &WsUrl{
		Host:     u.Hostname(),
		Port:     port,
		Path:     u.Path,
		RawQuery: u.RawQuery,
	}, nil
}

// WithConnectIP 返回带 connect_ip 的副本（契约 §6.2）。
func (w *WsUrl) WithConnectIP(ip string) *WsUrl {
	out := *w
	out.ConnectIP = strings.TrimSpace(ip)
	return &out
}

// tcpTarget 返回 TCP 连接目标（connect_ip 优先）。
//
// connect_ip 允许带端口：第三方反代入口常监听 2053 / 8443 / 2096 等非 443 端口，
// 只接受裸 IP 会让这些入口无法使用（旧实现硬拼 443，填 IP:port 会拼出非法地址）。
// 裸 IP / IPv6 字面量仍按 w.Port 处理；IPv6 要带端口时必须写成 [addr]:port。
func (w *WsUrl) tcpTarget() string {
	host := w.Host
	if w.ConnectIP != "" {
		if h, p, err := net.SplitHostPort(w.ConnectIP); err == nil && h != "" && p != "" {
			return net.JoinHostPort(h, p)
		}
		host = w.ConnectIP
	}
	return net.JoinHostPort(host, strconv.Itoa(w.Port))
}

// WsConn 封装到盲中继的 WebSocket 连接。
type WsConn struct {
	conn    *websocket.Conn
	url     *WsUrl
	writeMu sync.Mutex
	// gorilla/websocket 在一次 ReadMessage 失败后**再次读取会直接 panic**
	// （"repeated read on failed websocket connection"）。
	// 降级到 WSS 后如果连接被中继关闭，recv 循环会不断重试 Recv，
	// 于是第二次读取就把整个 meshd 进程打崩。这里记住永久失败状态，
	// 之后所有 Recv/Send 都直接返回错误，不再触碰底层连接。
	failed atomic.Bool
}

// failedErr 是连接失败后的固定错误（recv 循环会按错误退出/回退，而不是重试死循环）。
var errWsFailed = fmt.Errorf("mesh ws: 连接已失败，不再读写")

// DialWss 建立 WSS 连接（契约 §6.1-6.2，ws.rs:502-527）。
//
// connect_ip 语义：
//   - TCP 拨号目标 = (connect_ip, port)
//   - TLS SNI = 原始域名（TLSClientConfig.ServerName）
//   - HTTP Host 头 = 原始域名
//   - 证书按原始域名校验（不跳过）
//
// pinning 默认关闭（用户决策：TLS 仅伪装、身份靠 Noise）。
func DialWss(ctx context.Context, u *WsUrl, rootCAs *x509.CertPool) (*WsConn, error) {
	if u == nil {
		return nil, fmt.Errorf("mesh ws: nil WsUrl")
	}
	dialer := websocket.Dialer{
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// 强制连到 tcpTarget（connect_ip），忽略 gorilla 传来的 addr
			var d net.Dialer
			return d.DialContext(ctx, network, u.tcpTarget())
		},
		TLSClientConfig: &tls.Config{
			ServerName: u.Host, // SNI 用原域名
			RootCAs:    rootCAs,
			MinVersion: tls.VersionTLS12,
		},
		HandshakeTimeout: 15 * time.Second,
	}
	reqHeader := http.Header{}
	reqHeader.Set("Host", u.Host) // Host 头用原域名（gorilla 通常自动，这里显式保证）

	path := u.Path
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	wsURL := "wss://" + net.JoinHostPort(u.Host, strconv.Itoa(u.Port)) + path

	conn, _, err := dialer.DialContext(ctx, wsURL, reqHeader)
	if err != nil {
		return nil, fmt.Errorf("mesh ws: 拨号失败: %w", err)
	}
	conn.SetReadLimit(MaxFrame)
	return &WsConn{conn: conn, url: u}, nil
}

// SendFrame 发送一帧（1 WS Binary 消息 = 1 帧，契约 §6.3）。
func (c *WsConn) SendFrame(ctx context.Context, data []byte) error {
	if len(data) > MaxFrame {
		return fmt.Errorf("mesh ws: 帧 %d 字节超过 %d", len(data), MaxFrame)
	}
	if c.failed.Load() || c.conn == nil {
		return errWsFailed
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.failed.Load() {
		return errWsFailed
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		c.failed.Store(true)
		return fmt.Errorf("mesh ws: 发送失败: %w", err)
	}
	return nil
}

// RecvFrame 接收一帧（契约 §6.3）。
// Text 视为协议错误；Ping/Pong 由 gorilla 自动处理；Close/EOF 报错。
func (c *WsConn) RecvFrame(ctx context.Context) ([]byte, error) {
	if c.failed.Load() || c.conn == nil {
		return nil, errWsFailed
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	typ, data, err := c.conn.ReadMessage()
	if err != nil {
		// 永久失败：gorilla 不允许在失败连接上再次 ReadMessage（会 panic）。
		c.failed.Store(true)
		return nil, fmt.Errorf("mesh ws: 接收失败: %w", err)
	}
	if typ != websocket.BinaryMessage {
		c.failed.Store(true)
		return nil, fmt.Errorf("mesh ws: 非 Binary 消息（type=%d）", typ)
	}
	if len(data) > MaxFrame {
		c.failed.Store(true)
		return nil, fmt.Errorf("mesh ws: 帧 %d 字节超过 %d", len(data), MaxFrame)
	}
	return data, nil
}

// Close 关闭连接。
func (c *WsConn) Close() error { return c.conn.Close() }

// RelayRoomURL 构造盲中继房间 URL（契约 §1.5 / edge README）。
// networkHash: 8-64 位小写 hex；peerID: 16 位小写 hex。
func RelayRoomURL(domain, networkHash, peerID string) (string, error) {
	if len(networkHash) < 8 || len(networkHash) > 64 || !isLowerHex(networkHash) {
		return "", fmt.Errorf("mesh: network_hash 必须 8-64 位小写 hex")
	}
	if len(peerID) != 16 || !isLowerHex(peerID) {
		return "", fmt.Errorf("mesh: peer_id 必须 16 位小写 hex")
	}
	return fmt.Sprintf("wss://%s/mesh/%s?peer_id=%s", domain, networkHash, peerID), nil
}

func ResolveRelayRoomHash(configured string, psk [32]byte) string {
	room := strings.TrimSpace(configured)
	if room == "" || room == "<network_hash>" {
		tag := DeriveRoomTag(psk)
		return hex.EncodeToString(tag[:])
	}
	return room
}

func isLowerHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
