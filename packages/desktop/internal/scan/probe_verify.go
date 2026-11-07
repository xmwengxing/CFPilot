package scan

// 阶段二严格校验与阶段二点五真实隧道校验。
//
// 对照 CLI packages/cli/src/scan/true-probe.ts:
//   - probeWsPing      :473  → ProbeWSPing
//   - buildVlessTunnelPayload  :987 → BuildVlessTunnelPayload
//   - buildTrojanTunnelPayload :1001 → BuildTrojanTunnelPayload
//   - verifyTunnel     :1024 → VerifyTunnel
//
// 之前桌面版只有 ProbeWS101（只看 101 状态行）与测速阶段的 x-probe-bytes 头，
// 缺少这两层校验，导致「101 通但数据面不响应」「WS 路径/认证配置不对」的 IP
// 会混进优选结果，客户端表现为 -1。两者补齐后 CLI / 桌面版语义才可比。

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var uuidHexRE = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

// boolPtr 返回一个 *bool，用于表达「未做 / 通过 / 未通过」三态。
func boolPtr(v bool) *bool { return &v }

// normalizeWsPath 补前导斜杠并给缺省路径。
func normalizeWsPath(path string) string {
	p := strings.TrimSpace(path)
	if p == "" {
		return ProbeDefaultPath
	}
	if !strings.HasPrefix(p, "/") {
		return "/" + p
	}
	return p
}

// openUpgradeConn 建 TCP + TLS（SNI = host），写出 WebSocket 升级请求。
// 返回的 conn 已设置整体 deadline，调用方负责 Close。
func openUpgradeConn(ctx context.Context, ip string, port int, host, path string, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	raw, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprint(port)))
	if err != nil {
		return nil, err
	}
	conn := tls.Client(raw, &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true, // 候选 IP 直连，证书与 SNI 不匹配属预期
		NextProtos:         []string{"http/1.1"},
		MinVersion:         tls.VersionTLS12,
	})
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, err
	}
	req := strings.Join([]string{
		"GET " + normalizeWsPath(path) + " HTTP/1.1",
		"Host: " + host,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(keyBytes),
		"Sec-WebSocket-Version: 13",
		"User-Agent: " + UserAgent,
		"",
		"",
	}, "\r\n")
	if _, err := io.WriteString(conn, req); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// readUpgradeHead 读到响应头结束，返回状态码、机房、以及头之后的剩余字节
// （101 响应与第一个 WS 帧可能在同一批数据里到达，不能丢）。
func readUpgradeHead(conn net.Conn) (status int, colo string, rest []byte, err error) {
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 2048)
	for {
		n, e := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if idx := bytes.Index(buf, []byte("\r\n\r\n")); idx >= 0 {
				head := string(buf[:idx])
				line := head
				if cr := strings.IndexByte(line, '\r'); cr >= 0 {
					line = line[:cr]
				}
				if m := statusRe.FindStringSubmatch(line); len(m) > 1 {
					status = atoiSafe(m[1])
				}
				return status, extractColo(head), append([]byte(nil), buf[idx+4:]...), nil
			}
			if len(buf) > 8192 {
				return 0, "", nil, errors.New("响应头异常")
			}
		}
		if e != nil {
			return 0, "", nil, e
		}
	}
}

// ProbeWSPing 做 WS 101 握手 + 响应体内容校验。
//
// 101 成功后发 **text 帧** `PING`，要求数据面回 JSON 且 `pong === true`。
// 这样「握手通但数据面不响应」的 IP 会在阶段二被拦掉。
//
// PongVerified 语义与 CLI 一致：nil = 没做内容校验（握手就失败了），
// &false = 做了但没通过，&true = 通过。
func ProbeWSPing(ctx context.Context, ip string, port int, host string, timeout time.Duration, path string) WSResult {
	start := time.Now()
	finish := func(r WSResult) WSResult {
		r.IP = ip
		r.Latency = time.Since(start).Milliseconds()
		return r
	}

	conn, err := openUpgradeConn(ctx, ip, port, host, path, timeout)
	if err != nil {
		return finish(WSResult{Error: shortErr(err)})
	}
	defer func() { _ = conn.Close() }()

	status, colo, rest, err := readUpgradeHead(conn)
	if err != nil {
		return finish(WSResult{Error: shortErr(err)})
	}
	if status != 101 {
		return finish(WSResult{Status: status, Colo: colo, Error: fmt.Sprintf("HTTP %d", status)})
	}

	ping, err := encodeClientFrame([]byte("PING"), 0x01)
	if err != nil {
		return finish(WSResult{Status: status, PongVerified: boolPtr(false), Error: shortErr(err)})
	}
	if _, err := conn.Write(ping); err != nil {
		return finish(WSResult{Status: status, PongVerified: boolPtr(false), Error: shortErr(err)})
	}

	buf := rest
	received := ""
	tmp := make([]byte, 4096)
	for {
		for {
			frame, remain, ok := decodeServerFrame(buf)
			if !ok {
				break
			}
			buf = remain
			if frame.opcode == 8 {
				code := 1005
				if len(frame.payload) >= 2 {
					code = int(binary.BigEndian.Uint16(frame.payload[:2]))
				}
				return finish(WSResult{Status: status, PongVerified: boolPtr(false),
					Error: fmt.Sprintf("WS 关闭（code %d）", code)})
			}
			if frame.opcode == 1 || frame.opcode == 2 {
				received += string(frame.payload)
				var parsed struct {
					Pong bool   `json:"pong"`
					Colo string `json:"colo"`
				}
				if json.Unmarshal([]byte(received), &parsed) == nil && parsed.Pong {
					probeColo := strings.ToUpper(parsed.Colo)
					outColo := colo
					if probeColo != "" {
						outColo = probeColo // PONG 里的 colo 比 cf-ray 更可靠
					}
					return finish(WSResult{OK: true, Status: status, Colo: outColo,
						ProbeColo: probeColo, PongVerified: boolPtr(true)})
				}
			}
		}
		n, e := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if e != nil {
			msg := "PING 超时（数据面未响应）"
			if errors.Is(e, io.EOF) {
				msg = "数据面在 PONG 之前关闭连接"
			}
			return finish(WSResult{Status: status, PongVerified: boolPtr(false), Error: msg})
		}
	}
}

// DetectProbeEndpoint 判断目标域名上有没有 CFPilot 风格的探针端点。
//
// 返回 (found, known)：known=false 表示网络错误 / 超时、结论未知，
// 此时**不能**降级成纯 101 校验（否则会放进一批假活 IP），与 CLI
// `detectProbeEndpoint` 的 true/false/null 三态一致。
func DetectProbeEndpoint(ctx context.Context, host, path string, timeout time.Duration) (found bool, known bool) {
	url := "https://" + host + normalizeWsPath(path) + "?bytes=1024"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, false
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return false, false
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.Header.Get("x-probe-bytes") != "", true
}

// TunnelVerifyOptions 是真实隧道校验参数。
type TunnelVerifyOptions struct {
	IP             string
	Port           int
	Host           string
	WSPath         string
	UUID           string
	TrojanPassword string
	TargetHost     string
	TargetPort     int
	Timeout        time.Duration
}

// TunnelVerifyResult 是真实隧道校验结果。
type TunnelVerifyResult struct {
	OK         bool
	Stage      string // handshake | protocol | data
	Latency    int64
	FirstBytes string
	Error      string
}

// BuildVlessTunnelPayload 构造 VLESS 隧道首包（协议头 + HTTP 请求）。
func BuildVlessTunnelPayload(uuid, targetHost string, targetPort int, request string) ([]byte, error) {
	clean := strings.ReplaceAll(uuid, "-", "")
	if !uuidHexRE.MatchString(clean) {
		return nil, errors.New("UUID 不是 32 位十六进制")
	}
	id, err := hex.DecodeString(clean)
	if err != nil {
		return nil, err
	}
	host := []byte(targetHost)
	if len(host) == 0 || len(host) > 255 {
		return nil, errors.New("目标域名长度非法")
	}
	out := make([]byte, 0, 1+16+6+len(host)+len(request))
	out = append(out, 0x00) // version
	out = append(out, id...)
	// addons 长度 0 / TCP 命令 / 端口 / 域名类型 / 域名长度
	out = append(out, 0x00, 0x01, byte(targetPort>>8), byte(targetPort), 0x02, byte(len(host)))
	out = append(out, host...)
	out = append(out, request...)
	return out, nil
}

// BuildTrojanTunnelPayload 构造 Trojan 隧道首包（sha224 口令 + CRLF + 地址 + 请求）。
func BuildTrojanTunnelPayload(password, targetHost string, targetPort int, request string) ([]byte, error) {
	host := []byte(targetHost)
	if len(host) == 0 || len(host) > 255 {
		return nil, errors.New("目标域名长度非法")
	}
	h := sha256.New224()
	_, _ = h.Write([]byte(password))
	digest := hex.EncodeToString(h.Sum(nil))

	out := make([]byte, 0, 56+2+3+len(host)+2+2+len(request))
	out = append(out, digest...)
	out = append(out, '\r', '\n')
	out = append(out, 0x01, 0x03, byte(len(host))) // TCP / 域名
	out = append(out, host...)
	out = append(out, byte(targetPort>>8), byte(targetPort))
	out = append(out, '\r', '\n')
	out = append(out, request...)
	return out, nil
}

func tunnelTargetRequest(targetHost string) string {
	return "GET / HTTP/1.1\r\nHost: " + targetHost + "\r\nUser-Agent: " + UserAgent +
		"\r\nConnection: close\r\n\r\n"
}

// VerifyTunnel 走真实 wsPath + 真实凭据做一次端到端隧道校验。
//
// 101 后发 binary 帧（VLESS / Trojan 协议首包），要求收到目标站的真实数据。
// VLESS 会先回 2 字节协议响应头 `[0,0]`，判定时要剥掉。
func VerifyTunnel(ctx context.Context, opt TunnelVerifyOptions) TunnelVerifyResult {
	start := time.Now()
	finish := func(r TunnelVerifyResult) TunnelVerifyResult {
		r.Latency = time.Since(start).Milliseconds()
		return r
	}

	targetHost := opt.TargetHost
	if targetHost == "" {
		targetHost = "baidu.com"
	}
	targetPort := opt.TargetPort
	if targetPort == 0 {
		targetPort = 80
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	request := tunnelTargetRequest(targetHost)

	var payload []byte
	var err error
	isVless := opt.UUID != ""
	switch {
	case isVless:
		payload, err = BuildVlessTunnelPayload(opt.UUID, targetHost, targetPort, request)
	case opt.TrojanPassword != "":
		payload, err = BuildTrojanTunnelPayload(opt.TrojanPassword, targetHost, targetPort, request)
	default:
		return finish(TunnelVerifyResult{Stage: "protocol", Error: "缺少 uuid / trojanPassword"})
	}
	if err != nil {
		return finish(TunnelVerifyResult{Stage: "protocol", Error: err.Error()})
	}
	if strings.TrimSpace(opt.WSPath) == "" {
		return finish(TunnelVerifyResult{Stage: "protocol", Error: "缺少 wsPath"})
	}

	conn, err := openUpgradeConn(ctx, opt.IP, opt.Port, opt.Host, opt.WSPath, timeout)
	if err != nil {
		return finish(TunnelVerifyResult{Stage: "handshake", Error: shortErr(err)})
	}
	defer func() { _ = conn.Close() }()

	status, _, rest, err := readUpgradeHead(conn)
	if err != nil {
		return finish(TunnelVerifyResult{Stage: "handshake", Error: shortErr(err)})
	}
	if status != 101 {
		return finish(TunnelVerifyResult{Stage: "handshake", Error: fmt.Sprintf("HTTP %d", status)})
	}

	frame, err := encodeClientFrame(payload, 0x02)
	if err != nil {
		return finish(TunnelVerifyResult{Stage: "protocol", Error: shortErr(err)})
	}
	if _, err := conn.Write(frame); err != nil {
		return finish(TunnelVerifyResult{Stage: "data", Error: shortErr(err)})
	}

	buf := rest
	tmp := make([]byte, 4096)
	for {
		for {
			f, remain, ok := decodeServerFrame(buf)
			if !ok {
				break
			}
			buf = remain
			if f.opcode == 8 {
				code := 1005
				if len(f.payload) >= 2 {
					code = int(binary.BigEndian.Uint16(f.payload[:2]))
				}
				return finish(TunnelVerifyResult{Stage: "protocol", Error: fmt.Sprintf("WS 关闭（code %d）", code)})
			}
			if (f.opcode == 1 || f.opcode == 2) && len(f.payload) > 0 {
				body := f.payload
				if isVless && len(body) >= 2 && body[0] == 0x00 && body[1] == 0x00 {
					body = body[2:]
				}
				if len(body) > 0 {
					preview := body
					if len(preview) > 16 {
						preview = preview[:16]
					}
					return finish(TunnelVerifyResult{OK: true, FirstBytes: string(preview)})
				}
			}
		}
		n, e := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if e != nil {
			return finish(TunnelVerifyResult{Stage: "data", Error: "协议已发出但没有回包"})
		}
	}
}
