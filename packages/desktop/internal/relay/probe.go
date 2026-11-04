package relay

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultTimeout 是单个候选的总超时。
//
// 三个阶段串行（隧道 → TLS → HTTP），每个阶段都要留够余量：
// 跨境链路上反代入口的 TLS 握手常到 1 秒级。
const DefaultTimeout = 12 * time.Second

// DefaultConcurrency 是同时探测的候选数。
//
// 每条并发都是一个独立的 WS 隧道（也就是一个独立的 Worker 请求），
// 因此不受「单请求 6 条出站 TCP」的限制；8 条在实测里既能压满又不至于
// 让本机成为瓶颈。
const DefaultConcurrency = 8

// maxBodyBytes 是版本端点响应的读取上限。
const maxBodyBytes = 8192

// Options 是一次体检的公共参数。
type Options struct {
	// 数据面域名：WS 目标、TLS SNI 与 Host 头都用它
	Host string
	// 数据面端口（默认 443）
	Port   int
	WSPath string
	UUID   string
	// 数据面自己的 build，用于判断落点
	ExpectedBuild string
	Timeout       time.Duration
}

// Result 是单个候选的结论。
type Result struct {
	IP string
	/** TLS 握手成功（证书已按数据面域名校验） */
	OK bool
	/** 返回的 build 等于数据面自己的 build */
	BuildOK bool
	/** 隧道建立耗时（WS 握手 + VLESS 响应头） */
	TunnelMs int64
	/** TLS 握手耗时（经过候选代理到 CF 边缘） */
	TLSMs int64
	/** 版本端点往返耗时 */
	HTTPMs int64
	Status int
	Build  string
	Error  string
}

// FetchExpectedBuild 直接向数据面问「你是什么版本」。
func FetchExpectedBuild(ctx context.Context, host string, timeout time.Duration) (string, error) {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+"/__cfp_version", nil)
	if err != nil {
		return "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("读不到数据面版本：%w", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes))
	if err != nil {
		return "", fmt.Errorf("读不到数据面版本：%w", err)
	}
	var parsed struct {
		Build string `json:"build"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("数据面版本端点返回的不是 JSON")
	}
	if parsed.Build == "" {
		return "", fmt.Errorf("数据面没有返回 build，无法比对")
	}
	return parsed.Build, nil
}

// Probe 体检一个候选。
//
// 链路：本机 →（WS/VLESS 隧道）→ Worker →（明文 TCP）→ 候选:443
// → 按 SNI 转发 → CF 边缘 → 本机在这条隧道上完成 TLS 与 HTTP。
func Probe(ctx context.Context, opt Options, ip string) Result {
	result := Result{IP: ip}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	deadline := time.Now().Add(timeout)
	probeCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	tunnelStart := time.Now()
	conn, err := DialWebSocket(probeCtx, opt.Host, opt.Port, opt.WSPath, timeout)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer func() { _ = conn.Close() }()

	uuid, err := ParseUUID(opt.UUID)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	target, err := ParseIPv4(ip)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if _, err := conn.Write(BuildVLESSRequest(uuid, target, 443)); err != nil {
		result.Error = fmt.Sprintf("发送 VLESS 请求失败：%v", err)
		return result
	}
	// 响应头必须精确消费（含 addons），否则残留字节会被 TLS 当成记录头
	if _, _, err := ReadVLESSReply(conn); err != nil {
		result.Error = err.Error()
		return result
	}
	result.TunnelMs = time.Since(tunnelStart).Milliseconds()

	tlsStart := time.Now()
	// 与数据面隧道共用同一套 TLS 配置（也包含测试注入的根证书）
	tlsConfig := &tls.Config{
		ServerName: opt.Host,
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
	}
	if dialTLSConfigHook != nil {
		tlsConfig = dialTLSConfigHook(tlsConfig)
	}
	tlsConn := tls.Client(conn, tlsConfig)
	if err := tlsConn.HandshakeContext(probeCtx); err != nil {
		result.Error = fmt.Sprintf("TLS 握手失败（候选没有转发到你的域名）：%v", shortErr(err))
		return result
	}
	result.TLSMs = time.Since(tlsStart).Milliseconds()
	result.OK = true

	httpStart := time.Now()
	request := strings.Join([]string{
		"GET /__cfp_version HTTP/1.1",
		"Host: " + opt.Host,
		"Connection: close",
		"User-Agent: cfpilot-relay-probe",
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(tlsConn, request); err != nil {
		result.Error = fmt.Sprintf("发送请求失败：%v", shortErr(err))
		return result
	}

	req, _ := http.NewRequest(http.MethodGet, "https://"+opt.Host+"/__cfp_version", nil)
	res, err := http.ReadResponse(bufio.NewReader(tlsConn), req)
	if err != nil {
		result.Error = fmt.Sprintf("读响应失败：%v", shortErr(err))
		return result
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes))
	result.HTTPMs = time.Since(httpStart).Milliseconds()
	result.Status = res.StatusCode

	if res.StatusCode == http.StatusOK {
		var parsed struct {
			Build string `json:"build"`
		}
		if err := json.Unmarshal(body, &parsed); err == nil {
			result.Build = parsed.Build
			result.BuildOK = parsed.Build != "" && parsed.Build == opt.ExpectedBuild
		}
	}

	switch {
	case result.BuildOK:
		result.Error = ""
	case result.Status == http.StatusOK:
		result.Error = fmt.Sprintf("build 不匹配（%s ≠ %s）", orDash(result.Build), opt.ExpectedBuild)
	case result.Status == 0:
		result.Error = "无有效 HTTP 响应"
	default:
		result.Error = fmt.Sprintf("HTTP %d", result.Status)
	}
	return result
}

func orDash(v string) string {
	if v == "" {
		return "空"
	}
	return v
}

// shortErr 把 error 压成一行（去掉 dial 里冗长的包装）。
func shortErr(err error) string {
	msg := err.Error()
	if idx := strings.LastIndex(msg, ": "); idx >= 0 && len(msg) > 120 {
		msg = msg[idx+2:]
	}
	if len(msg) > 160 {
		msg = msg[:160]
	}
	return msg
}
