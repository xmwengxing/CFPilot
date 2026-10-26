// Package scan 实现本地真连接优选。
//
// ## 为什么需要「真连接」
//
// Cloudflare 的 IPv4 空间里大部分是区域/租户专用分配，对普通站点没有配置
// （返回 400 或直接超时）。只测 TCP 延迟会选出一堆「能建连但不能用」的 IP，
// 用户导进客户端后所有节点延迟都是 -1。
//
// 因此必须做**真连接验证**：用用户的域名做 TLS SNI + HTTP Host，
// 走完整 TLS 握手 + WebSocket 101 升级，只保留真的能完成升级的 IP。
//
// ## 与 Electron 版的关系
//
// 对应 packages/scanner-cli/src/true-probe.ts 与 scan.ts。
// 行为必须一致 —— 否则两版选出的 IP 不可比，用户会怀疑新版选得更差。
//
// ## 阶段划分（顺序不能变）
//
//	阶段一    TCP 握手初筛
//	阶段一之二 TLS 握手筛选（-1 根因修复，2026-10-24 新增）
//	阶段二    带用户域名的 WebSocket 101 校验（**强制前置**）
//	阶段三    只对过了阶段二的 IP 测真实下行速度
//
// ⚠️ 阶段三必须先过阶段二。跳过阶段二直接按速度排序，会选出
// 「速度很快但导入客户端全是 -1」的 IP。
package scan

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"
)

// UserAgent 是探测请求的 UA。
//
// 用常见浏览器 UA：部分 Cloudflare 边缘对陌生 UA 有额外风控。
const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// ProbeDefaultPath 是默认的探针路径。
//
// CFPilot 数据面固定提供 /__edge_probe（101 校验 + 下行测速），
// 这是项目的核心价值，不可删除。
const ProbeDefaultPath = "/__edge_probe"

// coloRe 从响应头里提取 Cloudflare 机房代码（cf-ray: xxx-NRT）。
var coloRe = regexp.MustCompile(`(?i)cf-ray:\s*[0-9a-f]+-([A-Z]{3})`)

// statusRe 匹配 HTTP 状态行。
var statusRe = regexp.MustCompile(`^HTTP/1\.[01]\s+(\d{3})`)

// extractColo 从响应文本里取机房代码。
func extractColo(text string) string {
	m := coloRe.FindStringSubmatch(text)
	if len(m) > 1 {
		return strings.ToUpper(m[1])
	}
	return ""
}

// ------------------------------------------------------------------
// 阶段一：TCP 握手
// ------------------------------------------------------------------

// TCPResult 是 TCP 握手探测结果。
type TCPResult struct {
	IP      string
	OK      bool
	Latency int64 // 毫秒
	Error   string
}

// ProbeTCP 测一次 TCP 握手耗时。
func ProbeTCP(ctx context.Context, ip string, port int, timeout time.Duration) TCPResult {
	start := time.Now()
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprint(port)))
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return TCPResult{IP: ip, Latency: latency, Error: shortErr(err)}
	}
	// 立刻关掉，不做任何协议交互
	_ = conn.Close()
	return TCPResult{IP: ip, OK: true, Latency: latency}
}

// ------------------------------------------------------------------
// 阶段一之二：TLS 握手
// ------------------------------------------------------------------

// TLSResult 是 TLS 握手探测结果。
type TLSResult struct {
	IP    string
	OK    bool
	TLSMs int64
	ALPN  string
	Error string
}

// ProbeTLS 做一次 TLS 握手（带用户域名作 SNI）。
//
// 三条与 JS 版对齐的关键点：
//
//  1. **InsecureSkipVerify = true**：优选 IP 上挂的是用户域名的证书，
//     用 IP 连接时证书名必然不匹配。这里不校验证书 ——
//     目的是「测通不通」，不是「验身份」。
//  2. **ALPN 固定 http/1.1**：与 probeWs101 一致。
//     协商不到 http/1.1 的 IP 走不了 WS，直接判失败。
//  3. **握手完成立刻关闭**，不产生额外请求。
func ProbeTLS(ctx context.Context, ip string, port int, host string, timeout time.Duration) TLSResult {
	start := time.Now()

	d := net.Dialer{Timeout: timeout}
	rawConn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprint(port)))
	if err != nil {
		return TLSResult{IP: ip, TLSMs: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}

	cfg := &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true, // 见上方注释 1
		NextProtos:         []string{"http/1.1"},
		MinVersion:         tls.VersionTLS12,
	}
	conn := tls.Client(rawConn, cfg)
	_ = conn.SetDeadline(time.Now().Add(timeout))

	if err := conn.HandshakeContext(ctx); err != nil {
		_ = rawConn.Close()
		return TLSResult{IP: ip, TLSMs: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}

	state := conn.ConnectionState()
	alpn := state.NegotiatedProtocol
	_ = conn.Close()

	// ALPN 没协商到 http/1.1 就无法升级 WS，判失败（与 JS 版一致）
	if alpn != "" && alpn != "http/1.1" {
		return TLSResult{IP: ip, TLSMs: time.Since(start).Milliseconds(), ALPN: alpn,
			Error: "ALPN=" + alpn}
	}
	return TLSResult{IP: ip, OK: true, TLSMs: time.Since(start).Milliseconds(), ALPN: alpn}
}

// ------------------------------------------------------------------
// 阶段二：WebSocket 101 校验
// ------------------------------------------------------------------

// WSResult 是 WS 101 探测结果。
type WSResult struct {
	IP      string
	OK      bool
	Colo    string
	Status  int
	Latency int64
	Error   string
}

// ProbeWS101 携带用户域名做 WebSocket 101 升级校验。
//
// 流程：TLS 握手（SNI = host）→ 发 GET + Upgrade 头 → 读到 101 即成功。
//
// ⚠️ 只有 101 才算通过。200 说明路径上没有 WS 处理器（可能是 Pages 的
// 静态资源或默认页），403 说明被风控，都不是可用节点。
func ProbeWS101(ctx context.Context, ip string, port int, host string, timeout time.Duration, path string) WSResult {
	if path == "" {
		path = ProbeDefaultPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	start := time.Now()
	finish := func(r WSResult) WSResult {
		r.IP = ip
		r.Latency = time.Since(start).Milliseconds()
		return r
	}

	d := net.Dialer{Timeout: timeout}
	rawConn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprint(port)))
	if err != nil {
		return finish(WSResult{Error: shortErr(err)})
	}

	conn := tls.Client(rawConn, &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true,
		NextProtos:         []string{"http/1.1"},
		MinVersion:         tls.VersionTLS12,
	})
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = rawConn.Close()
		return finish(WSResult{Error: shortErr(err)})
	}
	defer func() { _ = conn.Close() }()

	// Sec-WebSocket-Key 必须是 16 字节随机数的 base64
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		return finish(WSResult{Error: "生成 WS key 失败"})
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	req := strings.Join([]string{
		"GET " + path + " HTTP/1.1",
		"Host: " + host,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: " + key,
		"Sec-WebSocket-Version: 13",
		"User-Agent: " + UserAgent,
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(conn, req); err != nil {
		return finish(WSResult{Error: shortErr(err)})
	}

	// 只读状态行就够判断；但要多读一点以取 cf-ray 头
	buf := make([]byte, 4096)
	total := 0
	var sb strings.Builder
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		if n > 0 {
			total += n
			sb.Write(buf[:total][maxInt(0, total-n):])
		}
		// 已经能判断状态行了吗
		text := sb.String()
		if idx := strings.Index(text, "\r\n"); idx >= 0 {
			if m := statusRe.FindStringSubmatch(text[:idx]); len(m) > 1 {
				status := atoiSafe(m[1])
				if status == 101 {
					return finish(WSResult{OK: true, Colo: extractColo(text), Status: status})
				}
				return finish(WSResult{Colo: extractColo(text), Status: status,
					Error: fmt.Sprintf("HTTP %d", status)})
			}
		}
		if err != nil {
			return finish(WSResult{Error: "响应异常"})
		}
		if total > 4096 {
			return finish(WSResult{Error: "响应异常"})
		}
	}
	return finish(WSResult{Error: "响应异常"})
}

// ------------------------------------------------------------------
// 阶段三：真实下行测速
// ------------------------------------------------------------------

// DownloadResult 是测速结果。
type DownloadResult struct {
	IP        string
	OK        bool
	Bytes     int64
	SpeedMBps float64
	MS        int64
	Error     string
}

// MeasureDownload 在用户域名下测真实下行速度。
//
// ⚠️ 只能对**已通过 101 校验**的 IP 调用 —— 否则测的是
// 「某个能返回数据的 HTTP 服务」，不代表它是可用节点。
func MeasureDownload(
	ctx context.Context,
	ip string, port int, host string,
	bytesWanted int,
	timeout time.Duration,
	path string,
) DownloadResult {
	if path == "" {
		path = ProbeDefaultPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	start := time.Now()
	finish := func(received int64, errMsg string) DownloadResult {
		seconds := time.Since(start).Seconds()
		if seconds < 0.001 {
			seconds = 0.001
		}
		return DownloadResult{
			IP:        ip,
			OK:        received > 0,
			Bytes:     received,
			SpeedMBps: float64(received) / 1024 / 1024 / seconds,
			MS:        time.Since(start).Milliseconds(),
			Error:     errMsg,
		}
	}

	d := net.Dialer{Timeout: timeout}
	rawConn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprint(port)))
	if err != nil {
		return finish(0, shortErr(err))
	}

	conn := tls.Client(rawConn, &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true,
		NextProtos:         []string{"http/1.1"},
		MinVersion:         tls.VersionTLS12,
	})
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = rawConn.Close()
		return finish(0, shortErr(err))
	}
	defer func() { _ = conn.Close() }()

	req := strings.Join([]string{
		fmt.Sprintf("GET %s?bytes=%d HTTP/1.1", path, bytesWanted),
		"Host: " + host,
		"User-Agent: " + UserAgent,
		"Accept: */*",
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(conn, req); err != nil {
		return finish(0, shortErr(err))
	}

	// 先跳过响应头，再计字节数（否则把 200 OK 也算进下载量）
	buf := make([]byte, 32*1024)
	var headerEnd int64 = -1
	var received int64
	var headerBuf strings.Builder

	for {
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			break
		}
		n, readErr := conn.Read(buf)
		if n > 0 {
			if headerEnd < 0 {
				headerBuf.Write(buf[:n])
				text := headerBuf.String()
				idx := strings.Index(text, "\r\n\r\n")
				if idx < 0 {
					if len(text) > 8192 {
						return finish(0, "响应头异常")
					}
					continue
				}
				headerEnd = int64(idx + 4)
				// 响应头之后的字节才算负载
				bodyOffset := headerEnd - int64(len(text)-n)
				if bodyOffset < int64(n) {
					received += int64(n) - bodyOffset
				}
			} else {
				received += int64(n)
			}
			if received >= int64(bytesWanted) {
				return finish(received, "")
			}
		}
		if readErr != nil {
			if received > 0 {
				return finish(received, "")
			}
			return finish(received, "测速超时")
		}
	}
	return finish(received, "")
}

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------

// shortErr 把底层错误压成简短可读的字符串。
func shortErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return "超时"
	case strings.Contains(msg, "refused"):
		return "连接被拒"
	case strings.Contains(msg, "no such host"):
		return "域名解析失败"
	case strings.Contains(msg, "reset by peer"):
		return "连接被重置"
	}
	if len(msg) > 80 {
		msg = msg[:80]
	}
	return msg
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// 保证 sync 被使用（后续并发扫描会用到）
var _ = sync.WaitGroup{}
