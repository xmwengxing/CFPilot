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
//	阶段一之二 TLS 握手筛选（-1 根因修复，新增）
//	阶段二    带用户域名的 WebSocket 101 校验（**强制前置**）
//	阶段三    只对过了阶段二的 IP 测真实下行速度
//
// ⚠️ 阶段三必须先过阶段二。跳过阶段二直接按速度排序，会选出
// 「速度很快但导入客户端全是 -1」的 IP。
package scan

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"math"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"
)

// httpStatusRE 从 HTTP 响应头里取状态码。
var httpStatusRE = regexp.MustCompile(`^HTTP/1\.[01]\s+(\d{3})`)

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

// 测速计量默认参数。
//
// ⚠️ 逐项对照 CLI packages/cli/src/scan/true-probe.ts 的 measureThroughput 默认值，
// 两边**必须保持同一套语义**（AGENTS.md §2.2：CLI 是权威实现）：
//
//	connections = 3    多流才能填满链路（单流受拥塞窗口 / BDP 限制）
//	durationMs  = 6000 单次测量时长（不是整体预算）
//	warmupMs    = 1000 丢弃 TCP 慢启动样本
//	windowMs    = 400  滑动窗口峰值（只作诊断）
//	minBytes    = 32KB 挡掉报错页 / 欢迎页
const (
	defMeasureConnections = 3
	defMeasureDurationMs  = 6000
	defMeasureWarmupMs    = 1000
	defMeasureWindowMs    = 400
	defMeasureMinBytes    = 32 * 1024
	defMeasureBytes       = 5 * 1024 * 1024
	// defMeasureTimeoutMs 是兜底的整体预算（正常调用方都会显式传）。
	defMeasureTimeoutMs = 20000
	// maxMeasureConnections 是单次测量的连接数上限：
	// 再高只是在客户端侧排队，并不会让整条链路更快。
	maxMeasureConnections = 8
)

// DownloadResult 是测速结果。
//
// ## 三个速度口径（必须钉住）
//
//	avg（含握手 / TTFB 与慢启动） < steady（丢预热后的时长加权均值） < peak（单窗口峰值）
//
// **对外报告的下行速度只能用 SteadyMBps**。真机同一条链路实测
// 峰值 2.46 MB/s、稳态 1.14 MB/s —— 单个 400ms 窗口的突发能把峰值翻倍。
//
// 对照 CLI 的 ThroughputResult（packages/cli/src/scan/true-probe.ts）：
// SteadyMBps ↔ steadyMBps、PeakMBps ↔ peakMBps、AvgMBps ↔ avgMBps、
// Connections ↔ connections。
type DownloadResult struct {
	IP    string
	OK    bool
	Bytes int64
	// SteadyMBps 是**对外报告的下行速度**：预热期之后的「字节 ÷ 秒数」（按时长加权）。
	SteadyMBps float64
	// PeakMBps 是滑动窗口峰值，**只作诊断**，不要拿来排序。
	PeakMBps float64
	// AvgMBps 是含预热与握手的整段平均，会明显偏低，仅作诊断。
	AvgMBps float64
	// SpeedMBps 是兼容字段，恒等于 SteadyMBps（避免调用方漏改后读到旧口径）。
	//
	// Deprecated: 新代码请直接读 SteadyMBps。
	SpeedMBps float64
	// Connections 是实际完成 TLS 握手的连接数。
	Connections int
	MS          int64
	Error       string
}

// MeasureOptions 是一次吞吐测量的参数。
//
// 对照 CLI 的 ThroughputOptions：IP / Port ↔ ip / port、Host ↔ sniHost / requestHost、
// BytesWanted ↔ bytes（探针模式）、Timeout ↔ timeoutMs、Connections ↔ connections、
// Duration ↔ durationMs、Warmup ↔ warmupMs、Window ↔ windowMs、MinBytes ↔ minBytes。
type MeasureOptions struct {
	// IP 与 Port 是候选 IP / 端口（TCP 直连目标）。
	IP   string
	Port int
	// Host 同时作为 TLS SNI 与 HTTP Host（必须是用户自己的数据面域名）。
	Host string
	// BytesWanted 是每条连接请求的字节上限（探针端点按它封顶）。
	BytesWanted int
	// Timeout 是**整体预算**（含拨号 / 握手 / 传输），到点必返回。
	Timeout time.Duration
	// Path 是探针端点路径，默认 /__edge_probe。
	Path string

	// 以下字段留 0 用默认值（见 defMeasure*）。
	Connections int
	Duration    time.Duration
	Warmup      time.Duration
	Window      time.Duration
	MinBytes    int64
}

// windowMeter 是吞吐窗口计（纯逻辑 / 无 I/O，便于单测）。
//
// ## 为什么不能用「总字节 ÷ 总耗时」
//
// TCP 慢启动让开头几秒远低于链路能力。2026-10-28 真机实测同一条链路
// 逐秒速率：0.19 → 0.25 → 0.29 → 0.20 → 0.50 → 0.47 → 0.52 → 0.81 → 0.87 MB/s。
// 整段平均只有 0.42 MB/s，而稳态已到 0.87 —— 低估一倍以上。
//
// ## 为什么对外用「稳态均值」而不是「窗口峰值」
//
// 真机同一条链路、3 条并行连接、400ms 窗口实测：
// 逐窗 0.38 0.42 0.91 0.43 1.05 1.63 1.04 1.05 1.49 1.40 1.11 2.46 0.66，
// 稳态均值 1.14 MB/s，而峰值 2.46 MB/s —— 单个突发窗口能把峰值翻倍。
// 所以对外报 steady（预热后的时长加权均值），峰值只留作诊断。
//
// 对照 CLI 的 WindowMeter（packages/cli/src/scan/true-probe.ts）。
type windowMeter struct {
	startedAt time.Time
	warmup    time.Duration
	window    time.Duration

	// mu 保护共享计数：多条连接会并发 add，ticker 会并发 settle。
	mu            sync.Mutex
	windowBytes   int64
	windowStart   time.Time
	peak          float64
	total         int64
	steadyBytes   int64
	steadySeconds float64
}

// newWindowMeter 造一个窗口计。
func newWindowMeter(startedAt time.Time, warmup, window time.Duration) *windowMeter {
	if warmup < 0 {
		warmup = 0
	}
	if window <= 0 {
		window = defMeasureWindowMs * time.Millisecond
	}
	return &windowMeter{
		startedAt:   startedAt,
		warmup:      warmup,
		window:      window,
		windowStart: startedAt,
	}
}

// add 累计收到的字节，返回当前总字节数。
func (m *windowMeter) add(n int64) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n > 0 {
		m.windowBytes += n
		m.total += n
	}
	return m.total
}

// tick 结算当前窗口（由定时器按 window 调用），返回当前峰值（MB/s）。
func (m *windowMeter) tick(now time.Time) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settleLocked(now)
	return m.peak
}

// finish 收尾：结算最后一个不完整窗口，返回总字节 / 稳态 / 峰值。
//
// 快速链路（或极小预算）会在 warmup 之前就传完：此时一个窗口都没结算过，
// peak 会停在 0，被误判成「测速失败」。用整段平均兜底 —— 与 CLI 一致。
func (m *windowMeter) finish(now time.Time) (total int64, steadyMBps, peakMBps float64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.settleLocked(now)
	elapsed := now.Sub(m.startedAt).Seconds()
	if m.peak == 0 && m.total > 0 && elapsed > 0 {
		m.peak = float64(m.total) / 1024 / 1024 / elapsed
	}
	m.windowBytes = 0
	m.windowStart = now

	total = m.total
	peakMBps = m.peak
	if m.steadySeconds > 0 {
		steadyMBps = float64(m.steadyBytes) / 1024 / 1024 / m.steadySeconds
	} else {
		// 整段都在预热期：退回峰值，绝不能报 0（否则会被当成「测速失败」）。
		steadyMBps = m.peak
	}
	return
}

// settleLocked 结算一个窗口：慢启动期内只丢弃，不记峰值 / 稳态。
func (m *windowMeter) settleLocked(now time.Time) {
	dt := now.Sub(m.windowStart).Seconds()
	if dt <= 0 {
		return
	}
	n := m.windowBytes
	m.windowBytes = 0
	m.windowStart = now
	// 与 CLI 一致：按「窗口结束时刻」判断是否还在预热期。
	if now.Sub(m.startedAt) < m.warmup {
		return
	}
	m.steadyBytes += n
	m.steadySeconds += dt
	speed := float64(n) / 1024 / 1024 / dt
	if speed > m.peak {
		m.peak = speed
	}
}

// round2 四舍五入到两位小数（与 CLI 的 toFixed(2) 对齐）。
func round2(v float64) float64 {
	if v <= 0 {
		return 0
	}
	return math.Round(v*100) / 100
}

// parseHTTPStatus 从响应头文本里取状态码（取不到返回 0）。
func parseHTTPStatus(head string) int {
	line := head
	if idx := strings.Index(head, "\r\n"); idx >= 0 {
		line = head[:idx]
	}
	m := httpStatusRE.FindStringSubmatch(line)
	if len(m) > 1 {
		return atoiSafe(m[1])
	}
	return 0
}

// MeasureThroughput 在用户域名下测真实下行速度（多连接 + 丢预热 + 稳态口径）。
//
// ## 与 CLI 的对照（AGENTS.md §2.2：CLI 是权威实现）
//
// 本函数逐项对照 packages/cli/src/scan/true-probe.ts 的 measureThroughput：
//
//  1. 多连接（默认 3 条）：单条 TCP 受拥塞窗口 / BDP 限制，填不满链路。
//     真机同一条链路实测：单流稳态 0.47 MB/s，3 流稳态 1.14 MB/s（×2.4）。
//  2. 丢弃前 warmup（默认 1000ms）的慢启动样本，对外报**稳态吞吐**。
//  3. 校验 x-probe-bytes 响应头：目标没有探针端点时 Pages 会回
//     200 + HTML 欢迎页，把它当数据会产出「速度极低但 OK」的假阳性节点。
//
// ## 成功判定
//
// 状态码 200 + 收到字节 ≥ 32KB + 响应头校验通过，三者缺一不可。
//
// ⚠️ 只能对**已通过 101 校验**的 IP 调用 —— 否则测的是
// 「某个能返回数据的 HTTP 服务」，不代表它是可用节点。
func MeasureThroughput(ctx context.Context, opt MeasureOptions) DownloadResult {
	if opt.Path == "" {
		opt.Path = ProbeDefaultPath
	}
	if !strings.HasPrefix(opt.Path, "/") {
		opt.Path = "/" + opt.Path
	}
	if opt.BytesWanted <= 0 {
		opt.BytesWanted = defMeasureBytes
	}
	connCount := opt.Connections
	if connCount <= 0 {
		connCount = defMeasureConnections
	}
	if connCount > maxMeasureConnections {
		connCount = maxMeasureConnections
	}
	duration := opt.Duration
	if duration <= 0 {
		duration = defMeasureDurationMs * time.Millisecond
	}
	warmup := opt.Warmup
	if warmup <= 0 {
		warmup = defMeasureWarmupMs * time.Millisecond
	}
	window := opt.Window
	if window <= 0 {
		window = defMeasureWindowMs * time.Millisecond
	}
	minBytes := opt.MinBytes
	if minBytes <= 0 {
		minBytes = defMeasureMinBytes
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = defMeasureTimeoutMs * time.Millisecond
	}

	started := time.Now()
	// ⚠️ **整体预算**：上一轮刚修好的缺陷 —— 对方持续 trickle 数据时，
	// 每次读都能成功，读超时被无限推迟，整个测速永远不结束。
	// context.WithTimeout 保证到点必返回；读截止时间也钉在同一个 deadline 上。
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	overallDeadline := started.Add(timeout)

	meter := newWindowMeter(started, warmup, window)

	// 请求路径带上 bytes 参数（探针端点按它封顶；已带 query 时用 & 续接）。
	sep := "?"
	if strings.Contains(opt.Path, "?") {
		sep = "&"
	}
	request := strings.Join([]string{
		"GET " + opt.Path + sep + "bytes=" + fmt.Sprint(opt.BytesWanted) + " HTTP/1.1",
		"Host: " + opt.Host,
		"User-Agent: " + UserAgent,
		"Accept: */*",
		"Accept-Encoding: identity",
		"Connection: close",
		"",
		"",
	}, "\r\n")

	doneCh := make(chan struct{})
	resultCh := make(chan DownloadResult, 1)
	var finishOnce sync.Once

	var stateMu sync.Mutex
	var conns []net.Conn
	opened := 0
	lastError := ""
	headerMismatch := false

	isDone := func() bool {
		select {
		case <-doneCh:
			return true
		default:
			return false
		}
	}
	setError := func(msg string) {
		if msg == "" || isDone() {
			return
		}
		stateMu.Lock()
		// 保留第一条错误：后面的连接往往只是被主动关闭牵连。
		if lastError == "" {
			lastError = msg
		}
		stateMu.Unlock()
	}

	tickerDone := make(chan struct{})
	finish := func() {
		finishOnce.Do(func() {
			close(doneCh)
			close(tickerDone)
			stateMu.Lock()
			for _, c := range conns {
				_ = c.Close()
			}
			conns = nil
			nOpened := opened
			mismatch := headerMismatch
			errMsg := lastError
			stateMu.Unlock()

			now := time.Now()
			total, steady, peak := meter.finish(now)
			elapsed := now.Sub(started).Seconds()
			if elapsed < 0.001 {
				elapsed = 0.001
			}

			ok := !mismatch && total >= minBytes
			if ok {
				errMsg = ""
			} else if errMsg == "" {
				switch {
				case mismatch:
					errMsg = "目标不支持探针测速（响应头缺少 x-probe-bytes，不是 CFPilot 探针端点）"
				case total == 0:
					errMsg = "未收到数据"
				default:
					errMsg = fmt.Sprintf("载荷不足（%d/%d 字节）", total, minBytes)
				}
			}

			resultCh <- DownloadResult{
				IP:          opt.IP,
				OK:          ok,
				Bytes:       total,
				SteadyMBps:  round2(steady),
				PeakMBps:    round2(peak),
				AvgMBps:     round2(float64(total) / 1024 / 1024 / elapsed),
				SpeedMBps:   round2(steady),
				Connections: nOpened,
				MS:          now.Sub(started).Milliseconds(),
				Error:       errMsg,
			}
		})
	}

	// 每 window 结算一次窗口（慢启动期内的样本只丢弃）。
	go func() {
		t := time.NewTicker(window)
		defer t.Stop()
		for {
			select {
			case <-tickerDone:
				return
			case now := <-t.C:
				meter.tick(now)
			}
		}
	}()

	// 到 duration 收工（测量时长，不是失败）。
	timer := time.AfterFunc(duration, finish)
	defer timer.Stop()

	// 整体预算耗尽 / 用户取消也要立刻收口，不能等 duration。
	go func() {
		select {
		case <-runCtx.Done():
			finish()
		case <-doneCh:
		}
	}()

	openOne := func() {
		dialer := net.Dialer{Timeout: timeout}
		rawConn, err := dialer.DialContext(runCtx, "tcp", net.JoinHostPort(opt.IP, fmt.Sprint(opt.Port)))
		if err != nil {
			setError(shortErr(err))
			return
		}

		tlsConn := tls.Client(rawConn, &tls.Config{
			ServerName:         opt.Host,
			InsecureSkipVerify: true, // 优选 IP 上挂的是用户域名的证书，用 IP 连接时证书名必然不匹配
			NextProtos:         []string{"http/1.1"},
			MinVersion:         tls.VersionTLS12,
		})
		_ = tlsConn.SetDeadline(overallDeadline)
		if err := tlsConn.HandshakeContext(runCtx); err != nil {
			_ = rawConn.Close()
			setError(shortErr(err))
			return
		}

		// 登记连接（由 finish 统一关闭）。检查与登记必须在同一把锁里：
		// 否则 finish 可能在这两步之间关闭了连接列表，造成连接泄漏。
		stateMu.Lock()
		if isDone() {
			stateMu.Unlock()
			_ = tlsConn.Close()
			return
		}
		conns = append(conns, tlsConn)
		opened++
		stateMu.Unlock()

		if _, err := io.WriteString(tlsConn, request); err != nil {
			setError(shortErr(err))
			_ = tlsConn.Close()
			return
		}

		buf := make([]byte, 32*1024)
		var headerBuf []byte
		headerDone := false
		for {
			if isDone() {
				return
			}
			// 读超时钉在整体 deadline：不会因为「一直有数据」而被无限推迟。
			_ = tlsConn.SetReadDeadline(overallDeadline)
			n, readErr := tlsConn.Read(buf)
			if n > 0 {
				var total int64
				if headerDone {
					total = meter.add(int64(n))
				} else {
					headerBuf = append(headerBuf, buf[:n]...)
					idx := bytes.Index(headerBuf, []byte("\r\n\r\n"))
					if idx < 0 {
						if len(headerBuf) > 8192 {
							setError("响应头异常")
							finish()
							return
						}
						continue
					}
					head := string(headerBuf[:idx])
					// ⚠️ 必须校验状态码：探针端点返回 404 / 403 时，
					// 报错页也有字节数，不校验就会被当成「测速成功」。
					status := parseHTTPStatus(head)
					if status == 0 {
						setError("响应头异常")
						return
					}
					if status != 200 {
						setError(fmt.Sprintf("HTTP %d", status))
						return
					}
					// 探针端点独有标记：没有这个头的 200 是别的项目的欢迎页，
					// 把它的 HTML 当成「测速数据」会产出假阳性节点。
					if !strings.Contains(strings.ToLower(head), "x-probe-bytes:") {
						stateMu.Lock()
						headerMismatch = true
						stateMu.Unlock()
						setError("目标不支持探针测速（响应头缺少 x-probe-bytes，不是 CFPilot 探针端点）")
						finish()
						return
					}
					headerDone = true
					// 响应头之后的字节才算负载（可能和响应头在同一个 chunk 里）。
					total = meter.add(int64(len(headerBuf) - idx - 4))
					headerBuf = nil
				}
				// 收满请求的字节数就提前收工：探针端点按 bytes 封顶，
				// 没有继续读的必要（对应 CLI 里所有 socket 读完后 finish）。
				if total >= int64(opt.BytesWanted) {
					finish()
					return
				}
			}
			if readErr != nil {
				if !isDone() {
					msg := shortErr(readErr)
					if isTimeoutError(msg) {
						msg = "测速超时"
					}
					setError(msg)
				}
				return
			}
		}
	}

	var wg sync.WaitGroup
	for i := 0; i < connCount; i++ {
		if i > 0 {
			// 逐条错开 60ms，避免同时挤在同一拥塞窗口（对照 CLI 的 i * 60）。
			select {
			case <-runCtx.Done():
			case <-time.After(60 * time.Millisecond):
			}
		}
		if runCtx.Err() != nil {
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			openOne()
		}()
	}
	go func() {
		wg.Wait()
		finish()
	}()

	return <-resultCh
}

// MeasureDownload 是 MeasureThroughput 的薄封装，保留旧签名（调用方改动最小）。
//
// ⚠️ 两者**共用同一套计量实现**（多连接 + 丢预热 + 稳态），不要在这里再写一份。
// 需要调连接数 / 测量时长 / 预热 / 窗口时，直接调用 MeasureThroughput。
func MeasureDownload(
	ctx context.Context,
	ip string, port int, host string,
	bytesWanted int,
	timeout time.Duration,
	path string,
) DownloadResult {
	return MeasureThroughput(ctx, MeasureOptions{
		IP:          ip,
		Port:        port,
		Host:        host,
		BytesWanted: bytesWanted,
		Timeout:     timeout,
		Path:        path,
	})
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
	case strings.Contains(msg, "EOF") || strings.Contains(msg, "closed"):
		// 服务端主动断开 / 连接被本地关闭：统一成可读中文，
		// 避免测速失败时对外报一个光秃秃的 "EOF"。
		return "连接被关闭"
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
