// Package relay 实现「反代入口」候选的出站体检。
//
// # 测什么
//
// 生产的反代链路是**明文管道**：Worker 连到代理 IP:443，把客户端的 TLS
// ClientHello 原样转发出去，代理按 SNI 把字节送到目标。Worker 自己不做 TLS。
//
// 所以本包的做法是：本机开一条 VLESS/WS 隧道打到数据面，让 Worker 去
//
//	connect(候选 IP:443)
//
// 再由**本机**在这条隧道上完成 TLS 握手（SNI = 数据面域名）并请求版本端点。
//
// # 判据是双重的
//
//  1. TLS 证书按数据面域名校验通过 —— 证明候选确实把 SNI 转到了 Cloudflare；
//  2. 返回的 build 等于数据面自己的 build —— 证明落点确实是这台实例。
//
// 只看 TCP/TLS 通会把「连上了但转错地方」的候选当成好的。
package relay

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// wsGUID 是 RFC 6455 §4.2.2 规定的握手魔术串。
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocket opcode（RFC 6455 §5.2）。
const (
	opContinuation byte = 0x0
	opText         byte = 0x1
	opBinary       byte = 0x2
	opClose        byte = 0x8
	opPing         byte = 0x9
	opPong         byte = 0xA
)

// maxFramePayload 是我们愿意接受的单帧上限。
//
// 反代体检只回一个几百字节的 JSON；超过这个量级的帧说明链路已经不是我们
// 预期的样子（或者对端在灌数据），直接判错比继续读更安全。
const maxFramePayload = 1 << 20

// ErrClosed 表示对端发了 close 帧或底层连接已断。
var ErrClosed = errors.New("relay: 隧道已关闭")

// Conn 把 WebSocket 包装成字节流，供 tls.Client 使用。
//
// 只实现体检需要的那部分：二进制帧、分片重组、ping/pong、close。
// 不开启 permessage-deflate（握手请求里不声明），因此不存在解压问题。
type Conn struct {
	conn net.Conn
	br   *bufio.Reader

	// 当前数据帧剩余字节与掩码状态（服务端不应加掩码，但容错处理）
	remaining int64
	masked    bool
	maskKey   [4]byte
	maskPos   int

	closed bool

	// serverSide 为 true 时按服务端行为处理：发出的帧**不加掩码**。
	// 生产代码只用客户端模式；这个开关让测试可以拿同一个 Conn 搭一个
	// 真实的「数据面」来跑端到端链路。
	serverSide bool
}

// dialTLSConfigHook 让测试可以替换数据面连接的 TLS 配置（生产恒为 nil）。
//
// 端到端测试要连自签证书的假数据面，而 tls.Config 用的是系统根证书。
// 通过这个钩子注入 RootCAs，避免在生产代码里开 InsecureSkipVerify。
var dialTLSConfigHook func(*tls.Config) *tls.Config

// DialWebSocket 与数据面建立 WS 连接（TLS + 101 升级）。
//
// host 同时用于 TCP 目标、TLS SNI 与 Host 头 —— 三者必须一致，
// 否则 Cloudflare 边缘会按 SNI 路由到别的站点。
func DialWebSocket(ctx context.Context, host string, port int, path string, timeout time.Duration) (*Conn, error) {
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if port <= 0 {
		port = 443
	}

	dialer := net.Dialer{Timeout: timeout}
	raw, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return nil, fmt.Errorf("连接数据面失败：%w", err)
	}

	tlsConfig := &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
	}
	if dialTLSConfigHook != nil {
		tlsConfig = dialTLSConfigHook(tlsConfig)
	}
	tlsConn := tls.Client(raw, tlsConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("数据面 TLS 握手失败：%w", err)
	}
	_ = tlsConn.SetDeadline(time.Now().Add(timeout))

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = tlsConn.Close()
		return nil, fmt.Errorf("生成握手随机数失败：%w", err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	request := strings.Join([]string{
		"GET " + path + " HTTP/1.1",
		"Host: " + host,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: " + key,
		"Sec-WebSocket-Version: 13",
		"User-Agent: cfpilot-relay-probe",
		"",
		"",
	}, "\r\n")
	if _, err := tlsConn.Write([]byte(request)); err != nil {
		_ = tlsConn.Close()
		return nil, fmt.Errorf("发送升级请求失败：%w", err)
	}

	br := bufio.NewReader(tlsConn)
	status, headers, err := readResponseHead(br)
	if err != nil {
		_ = tlsConn.Close()
		return nil, err
	}
	if status != 101 {
		_ = tlsConn.Close()
		return nil, fmt.Errorf("WS 升级被拒：HTTP %d（检查 WS 路径）", status)
	}
	if got := headers["sec-websocket-accept"]; got != wsAccept(key) {
		_ = tlsConn.Close()
		return nil, errors.New("WS 升级响应校验失败（Sec-WebSocket-Accept 不匹配）")
	}

	return &Conn{conn: tlsConn, br: br}, nil
}

// readResponseHead 读 HTTP 响应头，返回状态码与**小写化**的头表。
//
// 不用 `http.ReadResponse`：那会把 101 响应的 Body 当成「读到连接关闭」的流，
// 把后续字节吃进它自己的缓冲，我们就拿不到裸隧道了。
func readResponseHead(br *bufio.Reader) (int, map[string]string, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return 0, nil, fmt.Errorf("读响应失败：%w", err)
	}
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
		return 0, nil, fmt.Errorf("响应不是 HTTP：%q", strings.TrimSpace(line))
	}
	var status int
	if _, err := fmt.Sscanf(fields[1], "%d", &status); err != nil {
		return 0, nil, fmt.Errorf("无法解析状态码：%q", fields[1])
	}

	headers := make(map[string]string)
	for {
		h, err := br.ReadString('\n')
		if err != nil {
			return 0, nil, fmt.Errorf("读响应头失败：%w", err)
		}
		h = strings.TrimRight(h, "\r\n")
		if h == "" {
			break
		}
		if idx := strings.Index(h, ":"); idx > 0 {
			headers[strings.ToLower(strings.TrimSpace(h[:idx]))] = strings.TrimSpace(h[idx+1:])
		}
	}
	return status, headers, nil
}

// wsAccept 计算 RFC 6455 的 Sec-WebSocket-Accept。
func wsAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// Read 读取隧道字节流（跨帧、跨分片）。
func (c *Conn) Read(p []byte) (int, error) {
	for {
		if c.remaining > 0 {
			n := len(p)
			if int64(n) > c.remaining {
				n = int(c.remaining)
			}
			read, err := io.ReadFull(c.br, p[:n])
			if read > 0 {
				if c.masked {
					unmask(c.maskKey, &c.maskPos, p[:read])
				}
				c.remaining -= int64(read)
			}
			if err != nil {
				return read, err
			}
			return read, nil
		}

		if c.closed {
			return 0, ErrClosed
		}
		opcode, fin, err := c.readFrameHeader()
		if err != nil {
			return 0, err
		}

		switch opcode {
		case opPing:
			payload := make([]byte, c.remaining)
			if _, err := io.ReadFull(c.br, payload); err != nil {
				return 0, err
			}
			c.remaining = 0
			if err := c.writeFrame(opPong, payload); err != nil {
				return 0, err
			}
			continue
		case opPong:
			payload := make([]byte, c.remaining)
			if _, err := io.ReadFull(c.br, payload); err != nil {
				return 0, err
			}
			c.remaining = 0
			continue
		case opClose:
			c.closed = true
			return 0, ErrClosed
		case opBinary, opText, opContinuation:
			if c.remaining == 0 {
				if fin {
					continue // 空数据帧，跳过
				}
				continue
			}
			continue
		default:
			return 0, fmt.Errorf("未知 WS 帧类型 0x%x", opcode)
		}
	}
}

// readFrameHeader 解析帧头，把负载长度写进 c.remaining。
func (c *Conn) readFrameHeader() (opcode byte, fin bool, err error) {
	var head [2]byte
	if _, err := io.ReadFull(c.br, head[:]); err != nil {
		return 0, false, err
	}
	fin = head[0]&0x80 != 0
	opcode = head[0] & 0x0F
	c.masked = head[1]&0x80 != 0
	length := int64(head[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, false, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, false, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if length < 0 || length > maxFramePayload {
		return 0, false, fmt.Errorf("WS 帧过大：%d 字节", length)
	}
	if c.masked {
		if _, err := io.ReadFull(c.br, c.maskKey[:]); err != nil {
			return 0, false, err
		}
		c.maskPos = 0
	}
	c.remaining = length
	return opcode, fin, nil
}

// Write 把 p 作为单个二进制帧发出（客户端必须加掩码）。
func (c *Conn) Write(p []byte) (int, error) {
	if err := c.writeFrame(opBinary, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *Conn) writeFrame(opcode byte, payload []byte) error {
	if c.closed {
		return ErrClosed
	}
	// 客户端发出的帧**必须**加掩码；服务端**必须**不加（RFC 6455 §5.3）。
	mask := !c.serverSide
	var maskBit byte
	if mask {
		maskBit = 0x80
	}

	header := make([]byte, 0, 14)
	header = append(header, 0x80|opcode) // FIN + opcode

	length := len(payload)
	switch {
	case length < 126:
		header = append(header, byte(length)|maskBit)
	case length <= 0xFFFF:
		header = append(header, 126|maskBit, byte(length>>8), byte(length))
	default:
		header = append(header, 127|maskBit)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}

	if !mask {
		if _, err := c.conn.Write(append(header, payload...)); err != nil {
			return err
		}
		return nil
	}

	maskKey := make([]byte, 4)
	if _, err := rand.Read(maskKey); err != nil {
		return err
	}
	header = append(header, maskKey...)

	masked := make([]byte, length)
	for i := 0; i < length; i++ {
		masked[i] = payload[i] ^ maskKey[i%4]
	}

	if _, err := c.conn.Write(append(header, masked...)); err != nil {
		return err
	}
	return nil
}

// unmask 就地把负载还原（服务端帧通常不带掩码，这里只做容错）。
func unmask(key [4]byte, pos *int, p []byte) {
	for i := range p {
		p[i] ^= key[*pos%4]
		*pos++
	}
}

// Close 发 close 帧并关闭底层连接（幂等）。
func (c *Conn) Close() error {
	if c.closed {
		return nil
	}
	// ⚠️ 先发 close 帧再置 closed —— 反过来的话 writeFrame 会直接返回 ErrClosed，
	// 对端只能看到 TCP 断开。
	_ = c.writeFrame(opClose, []byte{0x03, 0xE8}) // 1000 normal closure
	c.closed = true
	return c.conn.Close()
}

// SetDeadline 等三个方法是 net.Conn 的实现，转给底层 TLS 连接。
func (c *Conn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *Conn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }
func (c *Conn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *Conn) RemoteAddr() net.Addr               { return c.conn.RemoteAddr() }
