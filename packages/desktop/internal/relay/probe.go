package relay

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
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

// probeLookupIP 是域名 → IP 的解析入口，做成变量只为单测能注入，
// 避免测试依赖真实 DNS / 网络；生产恒走 net.DefaultResolver。
var probeLookupIP = func(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

// resolveProbeTarget 把候选解析成 VLESS 请求用的 IPv4。
//
// BuildVLESSRequest 只实现 IPv4 地址类型（atyp=0x01），所以域名不另起协议
// 分支，而是先取 A 记录里的第一个 IPv4 再复用原有头——改动最小、协议零风险。
// 解析失败或没有 IPv4 必须显式报错，不能静默跳过（否则失败会被误判成候选全挂）。
func resolveProbeTarget(ctx context.Context, candidate string) ([4]byte, error) {
	if target, err := ParseIPv4(candidate); err == nil {
		return target, nil
	}
	addrs, err := probeLookupIP(ctx, candidate)
	if err != nil {
		return [4]byte{}, fmt.Errorf("域名解析失败（%s）：%w", candidate, err)
	}
	for _, a := range addrs {
		if v4 := a.IP.To4(); v4 != nil {
			var out [4]byte
			copy(out[:], v4)
			return out, nil
		}
	}
	return [4]byte{}, fmt.Errorf("域名没有可用的 IPv4 记录：%s", candidate)
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
	target, err := resolveProbeTarget(probeCtx, ip)
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

// verifyForwarding 终检一个候选能否把流量转发到**指定的 CF 网段站点**。
//
// 链路与 Probe 完全一致，只是 TLS SNI 与 HTTP Host 换成校验网址，
// 且判定放宽为「收到任何 HTTP 响应就算通过」—— 403 / 302 也证明
// 入口确实把 SNI 转到了 CF 边缘（站点自己的风控与入口无关）。
//
// 剔除的是「能转发到自己的数据面、却转发不了别的站点」的假入口
// （只白名单特定 SNI 的转发器）。
func verifyForwarding(ctx context.Context, opt Options, ip, verifyHost string) (bool, error) {
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	deadline := time.Now().Add(timeout)
	probeCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	conn, err := DialWebSocket(probeCtx, opt.Host, opt.Port, opt.WSPath, timeout)
	if err != nil {
		return false, err
	}
	defer func() { _ = conn.Close() }()

	uuid, err := ParseUUID(opt.UUID)
	if err != nil {
		return false, err
	}
	target, err := resolveProbeTarget(probeCtx, ip)
	if err != nil {
		return false, err
	}
	if _, err := conn.Write(BuildVLESSRequest(uuid, target, 443)); err != nil {
		return false, err
	}
	if _, _, err := ReadVLESSReply(conn); err != nil {
		return false, err
	}

	tlsConfig := &tls.Config{
		ServerName: verifyHost,
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
	}
	if dialTLSConfigHook != nil {
		tlsConfig = dialTLSConfigHook(tlsConfig)
	}
	tlsConn := tls.Client(conn, tlsConfig)
	if err := tlsConn.HandshakeContext(probeCtx); err != nil {
		return false, fmt.Errorf("TLS 握手失败（候选没有转发到 %s）：%v", verifyHost, shortErr(err))
	}

	request := strings.Join([]string{
		"GET / HTTP/1.1",
		"Host: " + verifyHost,
		"Connection: close",
		"User-Agent: cfpilot-relay-verify",
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(tlsConn, request); err != nil {
		return false, err
	}
	res, err := http.ReadResponse(bufio.NewReader(tlsConn), nil)
	if err != nil {
		return false, fmt.Errorf("读响应失败：%v", shortErr(err))
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	// 收到任何 HTTP 状态行都算转发成功
	return res.StatusCode > 0, nil
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
