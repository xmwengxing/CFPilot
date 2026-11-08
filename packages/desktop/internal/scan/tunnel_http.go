package scan

// 穿候选隧道发真实 HTTP 的探测：目标站兼容性与隧道出口识别共用。
//
// 链路：本机 →(TLS+WS 升级，SNI=数据面域名)→ 候选 IP →(VLESS/Trojan 载荷)→
// Worker → 目标站。隧道里传的是目标站的裸字节：80 端口直接明文 HTTP，
// 443 端口由本机在隧道上做 TLS 握手（**严格校验证书**，与 egress 识别一致）。
//
// 对照 CLI packages/cli/src/experimental/website-compatibility.ts 的判定优先级：
// 明确挑战头 → 403 → 429 → 非 2xx → 压缩/超限 → 挑战正文 → 可选正文标记 → ok。
// 区别在于 CLI 走本机/SOCKS5 路径，这里走**候选 IP 的隧道**。

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// tunnelHTTPTimeout 是单目标总预算（与 CLI WEBSITE_TIMEOUT_MS 对齐）。
	tunnelHTTPTimeout = 8 * time.Second
	// tunnelHTTPMaxBody 是正文上限 16 KiB（与 CLI WEBSITE_MAX_BYTES 对齐）。
	tunnelHTTPMaxBody = 16 << 10
)

// tunnelConn 把 101 之后的 WS 隧道包装成字节流，供 tls.Client / http 读写使用。
//
// 只实现探测需要的部分：binary 帧双向透传、text 帧按数据、close 帧转 EOF、
// ping 帧回 pong。VLESS 的 2 字节协议响应头在第一次读时剥掉。
type tunnelConn struct {
	raw        net.Conn
	pending    []byte
	stripVless bool
	stripped   bool
	closed     bool
}

func (c *tunnelConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		tmp := make([]byte, 4096)
		n, err := c.raw.Read(tmp)
		if n > 0 {
			buf := tmp[:n]
			for {
				frame, rest, ok := decodeServerFrame(buf)
				if !ok {
					break
				}
				buf = rest
				switch frame.opcode {
				case 8: // close
					return 0, io.EOF
				case 9: // ping → 回 pong
					pong, encErr := encodeClientFrame(frame.payload, 0x0A)
					if encErr == nil {
						_, _ = c.raw.Write(pong)
					}
				case 1, 2:
					c.pending = append(c.pending, frame.payload...)
				}
			}
			if len(buf) > 0 {
				// 不完整帧：当前实现要求整帧到达（隧道响应帧由数据面整帧转发，
				// 与 VerifyTunnel 的读法一致）。
				return 0, errors.New("隧道响应帧不完整")
			}
		}
		if err != nil {
			return 0, err
		}
	}
	if c.stripVless && !c.stripped {
		if len(c.pending) < 2 {
			return 0, errors.New("隧道响应过短")
		}
		if c.pending[0] == 0x00 && c.pending[1] == 0x00 {
			c.pending = c.pending[2:]
		}
		c.stripped = true
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *tunnelConn) Write(p []byte) (int, error) {
	frame, err := encodeClientFrame(p, 0x02)
	if err != nil {
		return 0, err
	}
	if _, err := c.raw.Write(frame); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *tunnelConn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	// 先发 close 帧，再关底层（与数据面行为一致）。
	if frame, err := encodeClientFrame(closePayload(), 0x08); err == nil {
		_, _ = c.raw.Write(frame)
	}
	return c.raw.Close()
}

func closePayload() []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, 1000)
	return b
}

func (c *tunnelConn) LocalAddr() net.Addr                { return c.raw.LocalAddr() }
func (c *tunnelConn) RemoteAddr() net.Addr               { return c.raw.RemoteAddr() }
func (c *tunnelConn) SetDeadline(t time.Time) error      { return c.raw.SetDeadline(t) }
func (c *tunnelConn) SetReadDeadline(t time.Time) error  { return c.raw.SetReadDeadline(t) }
func (c *tunnelConn) SetWriteDeadline(t time.Time) error { return c.raw.SetWriteDeadline(t) }

// openTunnel 建立到候选 IP 的隧道并指向 targetHost:targetPort。
// 返回的 conn 已剥好协议层，调用方直接读写目标站字节。
func openTunnel(ctx context.Context, ip string, port int, host, wsPath string, uuid, trojanPassword, targetHost string, targetPort int, timeout time.Duration) (net.Conn, error) {
	var payload []byte
	var err error
	isVless := uuid != ""
	switch {
	case isVless:
		payload, err = BuildVlessTunnelPayload(uuid, targetHost, targetPort, "")
	case trojanPassword != "":
		payload, err = BuildTrojanTunnelPayload(trojanPassword, targetHost, targetPort, "")
	default:
		return nil, errors.New("缺少 uuid / trojanPassword")
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(wsPath) == "" {
		return nil, errors.New("缺少 wsPath")
	}
	raw, err := openUpgradeConn(ctx, ip, port, host, wsPath, timeout)
	if err != nil {
		return nil, err
	}
	status, _, rest, err := readUpgradeHead(raw)
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	if status != 101 {
		_ = raw.Close()
		return nil, fmt.Errorf("HTTP %d", status)
	}
	frame, err := encodeClientFrame(payload, 0x02)
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	if _, err := raw.Write(frame); err != nil {
		_ = raw.Close()
		return nil, err
	}
	c := &tunnelConn{raw: raw, stripVless: isVless}
	if len(rest) > 0 {
		// 101 响应与第一个数据帧同批到达的残留字节：先喂进解码缓冲。
		// 这里包一层：把 rest 重新注入 pending 的解码路径。
		c.pending = append(c.pending, rest...)
		// pending 里是**原始帧字节**而非载荷，需立即解码一次。
		buf := c.pending
		c.pending = nil
		for {
			f, remain, ok := decodeServerFrame(buf)
			if !ok {
				break
			}
			buf = remain
			if f.opcode == 1 || f.opcode == 2 {
				c.pending = append(c.pending, f.payload...)
			}
		}
	}
	return c, nil
}

// TunnelWebsiteTarget 是穿隧道检测的一个目标站（HTTP 明文或 HTTPS）。
type TunnelWebsiteTarget struct {
	Label        string
	Host         string // 目标域名（同时作 TLS SNI）
	Port         int    // 80 或 443（其它端口亦可透传，但证书校验只在 443 生效）
	Path         string // 以 / 开头
	ExpectedText string // 可选正文标记（纯文本，≤1024 字节）
}

// TunnelWebsiteResult 是一次穿隧道目标站探测的结果。
type TunnelWebsiteResult struct {
	Label             string
	Status            string // ok / challenge / forbidden / rate_limited / tls_error / timeout / http_error / invalid_response
	HTTPStatus        int
	ChallengeHeader   bool
	Ms                int64
	ExpectedContentOK *bool
	Error             string
}

// TunnelProbeOptions 是穿隧道探测的参数（仅内存，不落盘）。
type TunnelProbeOptions struct {
	IP             string
	Port           int
	Host           string // 数据面域名（WS 升级 SNI/Host）
	WSPath         string
	UUID           string
	TrojanPassword string
	Timeout        time.Duration
}

// validateTunnelTarget 校验目标站：拒绝私网 IP 字面量与本地域名（与出口识别同边界）。
func validateTunnelTarget(t TunnelWebsiteTarget) error {
	host := strings.ToLower(strings.TrimSuffix(t.Host, "."))
	if host == "" || len(host) > 253 || strings.ContainsFunc(host, unicode.IsControl) {
		return errors.New("目标域名无效")
	}
	if t.Port < 1 || t.Port > 65535 {
		return errors.New("目标端口无效")
	}
	if !strings.HasPrefix(t.Path, "/") || len(t.Path) > 2048 || strings.ContainsFunc(t.Path, unicode.IsControl) {
		return errors.New("目标路径无效")
	}
	if len(t.ExpectedText) > 1024 {
		return errors.New("正文标记过长")
	}
	if ip := net.ParseIP(host); ip != nil {
		if _, err := validatePublicIP(ip.String()); err != nil {
			return errors.New("目标不能使用非公网 IP")
		}
	} else if host == "localhost" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || !strings.Contains(host, ".") {
		return errors.New("目标不能使用本地地址")
	}
	return nil
}

// classifyTunnelResponse 按 CLI website-compatibility 的判定优先级分类。
func classifyTunnelResponse(status int, headers http.Header, body []byte, expectedText string) TunnelWebsiteResult {
	res := TunnelWebsiteResult{HTTPStatus: status}
	if strings.EqualFold(strings.TrimSpace(headers.Get("cf-mitigated")), "challenge") {
		res.ChallengeHeader = true
		res.Status = "challenge"
		return res
	}
	switch {
	case status == 403:
		res.Status = "forbidden"
	case status == 429:
		res.Status = "rate_limited"
	case status < 200 || status >= 300:
		res.Status = "http_error"
		if status >= 300 && status < 400 {
			res.Error = "目标返回重定向，未跟随"
		} else {
			res.Error = "目标返回非成功状态码"
		}
	case headers.Get("Content-Encoding") != "" && !strings.EqualFold(headers.Get("Content-Encoding"), "identity"):
		res.Status = "invalid_response"
		res.Error = "目标返回压缩内容，未解压"
	case len(body) > tunnelHTTPMaxBody:
		res.Status = "invalid_response"
		res.Error = "网站响应超过 16 KiB"
	default:
		contentType := headers.Get("Content-Type")
		if strings.HasPrefix(strings.ToLower(contentType), "text/html") && strings.Contains(string(body), "/cdn-cgi/challenge-platform/") {
			res.Status = "challenge"
			return res
		}
		if expectedText != "" {
			text, err := decodeUTF8(body)
			if err != nil || !strings.Contains(text, expectedText) {
				res.Status = "invalid_response"
				ok := false
				res.ExpectedContentOK = &ok
				res.Error = "正文不符合显式检测条件"
				return res
			}
			ok := true
			res.ExpectedContentOK = &ok
		}
		res.Status = "ok"
	}
	return res
}

func decodeUTF8(b []byte) (string, error) {
	if !utf8.Valid(b) {
		return "", errors.New("invalid utf-8")
	}
	return string(b), nil
}

// ProbeTunnelWebsite 穿候选隧道访问一个目标站并分类（串行单目标）。
func ProbeTunnelWebsite(ctx context.Context, opt TunnelProbeOptions, target TunnelWebsiteTarget) TunnelWebsiteResult {
	start := time.Now()
	res := TunnelWebsiteResult{Label: target.Label}
	finish := func(patch TunnelWebsiteResult) TunnelWebsiteResult {
		res = patch
		res.Label = target.Label
		res.Ms = time.Since(start).Milliseconds()
		return res
	}
	if err := validateTunnelTarget(target); err != nil {
		return finish(TunnelWebsiteResult{Status: "http_error", Error: "网站检测配置无效"})
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = tunnelHTTPTimeout
	}
	if timeout > tunnelHTTPTimeout {
		timeout = tunnelHTTPTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	stream, err := openTunnel(callCtx, opt.IP, opt.Port, opt.Host, opt.WSPath, opt.UUID, opt.TrojanPassword, target.Host, target.Port, timeout)
	if err != nil {
		if callCtx.Err() != nil {
			return finish(TunnelWebsiteResult{Status: "timeout", Error: "网站检测超过总超时预算"})
		}
		return finish(TunnelWebsiteResult{Status: "http_error", Error: "隧道建立失败"})
	}
	defer func() { _ = stream.Close() }()

	var transport net.Conn = stream
	if target.Port == 443 {
		tlsConn := tls.Client(stream, &tls.Config{
			ServerName: target.Host,
			MinVersion: tls.VersionTLS12,
			NextProtos: []string{"http/1.1"},
		})
		_ = tlsConn.SetDeadline(time.Now().Add(timeout))
		if err := tlsConn.HandshakeContext(callCtx); err != nil {
			if callCtx.Err() != nil {
				return finish(TunnelWebsiteResult{Status: "timeout", Error: "网站检测超过总超时预算"})
			}
			return finish(TunnelWebsiteResult{Status: "tls_error", Error: "网站 TLS 校验失败"})
		}
		transport = tlsConn
	}
	_ = transport.SetDeadline(time.Now().Add(timeout))

	reqText := strings.Join([]string{
		"GET " + target.Path + " HTTP/1.1",
		"Host: " + target.Host,
		"User-Agent: " + UserAgent,
		"Accept: */*",
		"Accept-Encoding: identity",
		"Cache-Control: no-store",
		"Connection: close",
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(transport, reqText); err != nil {
		if callCtx.Err() != nil {
			return finish(TunnelWebsiteResult{Status: "timeout", Error: "网站检测超过总超时预算"})
		}
		return finish(TunnelWebsiteResult{Status: "http_error", Error: "指定路径连接失败"})
	}
	req, _ := http.NewRequest(http.MethodGet, "http://"+target.Host+target.Path, nil)
	resp, err := http.ReadResponse(bufio.NewReader(transport), req)
	if err != nil {
		if callCtx.Err() != nil {
			return finish(TunnelWebsiteResult{Status: "timeout", Error: "网站检测超过总超时预算"})
		}
		return finish(TunnelWebsiteResult{Status: "http_error", Error: "指定路径连接失败"})
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, tunnelHTTPMaxBody+1))
	if err != nil {
		return finish(TunnelWebsiteResult{Status: "http_error", Error: "网站响应传输失败"})
	}
	classified := classifyTunnelResponse(resp.StatusCode, resp.Header, body, target.ExpectedText)
	classified.Ms = time.Since(start).Milliseconds()
	return finish(classified)
}

// IdentifyTunnelEgress 穿候选隧道请求用户识别服务，得到**候选出口**（隧道版）。
//
// 识别服务必须是 HTTPS；443 端口走隧道内 TLS（严格校验证书）。
// remote_ip 必须由服务按连接对端提供，客户端不采信 X-Forwarded-For。
func IdentifyTunnelEgress(ctx context.Context, opt TunnelProbeOptions, serviceURL string) (EgressIdentityResult, error) {
	service, err := validateIdentityURL(serviceURL)
	if err != nil {
		return EgressIdentityResult{}, err
	}
	host := service.Hostname()
	port := 443
	if service.Port() != "" {
		port, _ = strconv.Atoi(service.Port())
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = EgressIdentityTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	stream, err := openTunnel(callCtx, opt.IP, opt.Port, opt.Host, opt.WSPath, opt.UUID, opt.TrojanPassword, host, port, timeout)
	if err != nil {
		return EgressIdentityResult{}, errors.New("隧道建立失败")
	}
	defer func() { _ = stream.Close() }()

	tlsConn := tls.Client(stream, &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
	})
	_ = tlsConn.SetDeadline(time.Now().Add(timeout))
	if err := tlsConn.HandshakeContext(callCtx); err != nil {
		return EgressIdentityResult{}, errors.New("识别服务 TLS 握手失败")
	}
	requestURI := service.RequestURI()
	if requestURI == "" {
		requestURI = "/"
	}
	reqText := strings.Join([]string{
		"GET " + requestURI + " HTTP/1.1",
		"Host: " + host,
		"Accept: application/json",
		"Accept-Encoding: identity",
		"Cache-Control: no-cache",
		"Connection: close",
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(tlsConn, reqText); err != nil {
		return EgressIdentityResult{}, errors.New("请求出口识别服务失败")
	}
	req, _ := http.NewRequest(http.MethodGet, service.String(), nil)
	resp, err := http.ReadResponse(bufio.NewReader(tlsConn), req)
	if err != nil {
		return EgressIdentityResult{}, errors.New("出口识别服务响应无效")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return EgressIdentityResult{}, fmt.Errorf("出口识别服务返回 HTTP %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		return EgressIdentityResult{}, errors.New("出口识别响应必须是 application/json")
	}
	if enc := strings.TrimSpace(resp.Header.Get("Content-Encoding")); enc != "" && !strings.EqualFold(enc, "identity") {
		return EgressIdentityResult{}, errors.New("出口识别响应不允许压缩")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, EgressIdentityMaxBody+1))
	if err != nil || len(body) > EgressIdentityMaxBody {
		return EgressIdentityResult{}, errors.New("出口识别响应超过 16 KiB 限制")
	}
	var payload egressIdentityResponse
	if !utf8.Valid(body) {
		return EgressIdentityResult{}, errors.New("出口识别响应不是合法 JSON")
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return EgressIdentityResult{}, errors.New("出口识别响应不是合法 JSON")
	}
	remoteIP, err := validatePublicIP(payload.RemoteIP)
	if err != nil {
		return EgressIdentityResult{}, err
	}
	observed, err := time.Parse(time.RFC3339Nano, payload.ObservedAt)
	if err != nil {
		return EgressIdentityResult{}, errors.New("出口识别时间不是 RFC3339")
	}
	fetched := time.Now().UTC()
	if observed.After(fetched.Add(EgressIdentityFutureTolerance)) {
		return EgressIdentityResult{}, errors.New("出口识别时间超出未来容差")
	}
	if fetched.Sub(observed) > EgressIdentityMaxAge {
		return EgressIdentityResult{}, errors.New("出口识别结果已超过 5 分钟")
	}
	if !validIdentityText(payload.EgressKind) || !validIdentityText(payload.Colo) {
		return EgressIdentityResult{}, errors.New("出口识别文本字段无效")
	}
	age := fetched.Sub(observed).Milliseconds()
	if age < 0 {
		age = 0
	}
	service.RawQuery, service.ForceQuery = "", false
	return EgressIdentityResult{Transport: "tunnel", FetchedAt: fetched, AgeMs: age, RemoteIP: remoteIP, ObservedAt: observed.UTC(), EgressKind: strings.TrimSpace(payload.EgressKind), Colo: strings.TrimSpace(payload.Colo), SourceURL: service.String()}, nil
}
