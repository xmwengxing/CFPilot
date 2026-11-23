package scan

// XHTTP（packet-up）探测：对照 CLI packages/cli/src/scan/true-probe.ts 的
// probeXhttpEndpoint 与 verifyXhttpTunnel。
//
// 优选 IP 通用（WS 的池可用作 XHTTP），但必须补 H2 校验：
// WS 探针打的是 HTTP/1.1 的 101，XHTTP 走 H2 的 POST/GET，
// 封 Upgrade 的网络会误杀可用的 XHTTP 候选。

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// neutralPageMarker 是数据面中性页的判据文本。
//
// 数据面对未认证 / 未命中的入站请求一律回这张静态页（绝不回显协议报错），
// 所以「无凭据探针能不能通」只能看响应体是不是本站这张页。
// ⚠️ 必须与 packages/worker-core/src/ui/neutral.ts 一致，
// scripts/check-xhttp-probe-marker.mjs 会校验两边没有漂移。
const neutralPageMarker = "This site is up and running."

// XHTTPResult 是无凭据端点探针结果。
type XHTTPResult struct {
	IP      string
	OK      bool
	Colo    string
	Status  int
	Latency int64
	Error   string
}

// XHTTPVerifyResult 是真隧道校验结果。
type XHTTPVerifyResult struct {
	OK        bool
	Stage     string
	Latency   int64
	Colo      string
	FirstByte string
	Error     string
}

func randomXHTTPSession() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "sess-" + hex.EncodeToString(b)
}

func xhttpClient(ip string, port int, host string, timeout time.Duration) *http.Client {
	d := net.Dialer{Timeout: timeout}
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprint(port)))
			},
			TLSClientConfig: &tls.Config{
				ServerName:         host,
				InsecureSkipVerify: true,
				NextProtos:         []string{"h2"},
				MinVersion:         tls.VersionTLS12,
			},
			ForceAttemptHTTP2: true,
		},
		Timeout: timeout,
	}
}

func xhttpBase(path string) string {
	path = strings.TrimSpace(path)
	path = strings.TrimRight(path, "/")
	if path == "" {
		return "/xhttp"
	}
	return path
}

func coloFromRay(ray string) string {
	ray = strings.TrimSpace(ray)
	if ray == "" {
		return ""
	}
	if i := strings.LastIndex(ray, "-"); i >= 0 && len(ray)-i == 4 {
		return strings.ToUpper(ray[i+1:])
	}
	return extractColo("cf-ray: " + ray)
}

// ProbeXHTTP 端点存活探针（无凭据）。
//
// 早前这里期望 HTTP 400（旧数据面「协议头非法」的状态码）。现在数据面
// 对入站请求一律回中性页 200，于是每个候选都被判成「HTTP 200」失败 ——
// XHTTP 优选必然全军覆没（2026-11-23 真机定位）。
//
// 现在的判据看响应形态：
//   - 200 + content-type: text/event-stream → 认证已通过；
//   - 200 + body 是本站中性页 → 命中本数据面（无凭据时的判据）；
//   - 200 + 其它 body → 不是本站（域名或 XHTTP 路径不对）；
//   - 400 / 403 / 其它 → 按原因失败。
func ProbeXHTTP(ctx context.Context, ip string, port int, host string, xhttpPath string, timeout time.Duration) XHTTPResult {
	start := time.Now()
	base := xhttpBase(xhttpPath)
	session := randomXHTTPSession()
	client := xhttpClient(ip, port, host, timeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("https://%s:%d%s/%s/0", host, port, base, session), bytes.NewReader([]byte("probe")))
	if err != nil {
		return XHTTPResult{IP: ip, Latency: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Referer", fmt.Sprintf("https://%s%s/?x_padding=%s", host, base, strings.Repeat("X", 200)))
	resp, err := client.Do(req)
	if err != nil {
		return XHTTPResult{IP: ip, Latency: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}
	defer func() { _ = resp.Body.Close() }()
	colo := coloFromRay(resp.Header.Get("Cf-Ray"))
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if resp.StatusCode == http.StatusOK && strings.Contains(contentType, "text/event-stream") {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return XHTTPResult{IP: ip, OK: true, Colo: colo, Status: resp.StatusCode, Latency: time.Since(start).Milliseconds()}
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusOK {
		if bytes.Contains(body, []byte(neutralPageMarker)) {
			return XHTTPResult{IP: ip, OK: true, Colo: colo, Status: resp.StatusCode, Latency: time.Since(start).Milliseconds()}
		}
		return XHTTPResult{IP: ip, Colo: colo, Status: resp.StatusCode, Latency: time.Since(start).Milliseconds(),
			Error: "HTTP 200（响应不是本站数据面，检查域名与 XHTTP 路径）"}
	}
	msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
	if resp.StatusCode == 403 {
		msg = "HTTP 403（边缘拦截）"
	} else if resp.StatusCode == 400 {
		msg = "HTTP 400（边缘拒绝该请求）"
	}
	return XHTTPResult{IP: ip, Colo: colo, Status: resp.StatusCode, Latency: time.Since(start).Milliseconds(), Error: msg}
}

// VerifyXHTTPTunnel 真隧道校验（需 uuid）。
func VerifyXHTTPTunnel(ctx context.Context, ip string, port int, host string, xhttpPath string, uuid string, targetHost string, targetPort int, timeout time.Duration) XHTTPVerifyResult {
	start := time.Now()
	base := xhttpBase(xhttpPath)
	if targetHost == "" {
		targetHost = "baidu.com"
	}
	if targetPort == 0 {
		targetPort = 80
	}
	payload, err := BuildVlessTunnelPayload(uuid, targetHost, targetPort, tunnelTargetRequest(targetHost))
	if err != nil {
		return XHTTPVerifyResult{Stage: "protocol", Latency: time.Since(start).Milliseconds(), Error: "缺少 uuid"}
	}
	session := randomXHTTPSession()
	client := xhttpClient(ip, port, host, timeout)
	stage := "handshake"
	upURL := fmt.Sprintf("https://%s:%d%s/%s/0", host, port, base, session)
	upReq, err := http.NewRequestWithContext(ctx, http.MethodPost, upURL, bytes.NewReader(payload))
	if err != nil {
		return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}
	upReq.Header.Set("Content-Type", "text/plain")
	upReq.Header.Set("Referer", fmt.Sprintf("https://%s%s/?x_padding=%s", host, base, strings.Repeat("X", 200)))
	upResp, err := client.Do(upReq)
	if err != nil {
		return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}
	_, _ = io.Copy(io.Discard, upResp.Body)
	_ = upResp.Body.Close()
	if upResp.StatusCode != 200 {
		return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: fmt.Sprintf("HTTP %d", upResp.StatusCode)}
	}
	stage = "protocol"
	downURL := fmt.Sprintf("https://%s:%d%s/%s", host, port, base, session)
	downReq, err := http.NewRequestWithContext(ctx, http.MethodGet, downURL, nil)
	if err != nil {
		return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}
	downReq.Header.Set("Referer", fmt.Sprintf("https://%s%s/?x_padding=%s", host, base, strings.Repeat("X", 200)))
	downResp, err := client.Do(downReq)
	if err != nil {
		return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: shortErr(err)}
	}
	defer func() { _ = downResp.Body.Close() }()
	if downResp.StatusCode != 200 {
		return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: fmt.Sprintf("HTTP %d", downResp.StatusCode)}
	}
	stage = "data"
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	headDone := false
	for {
		n, err := downResp.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if !headDone {
				if len(buf) < 2 {
					continue
				}
				if buf[0] != 0x00 || buf[1] != 0x00 {
					return XHTTPVerifyResult{Stage: "protocol", Latency: time.Since(start).Milliseconds(), Error: "VLESS 响应头非法"}
				}
				headDone = true
				buf = buf[2:]
			}
			if headDone && len(buf) > 0 {
				end := 16
				if len(buf) < end {
					end = len(buf)
				}
				return XHTTPVerifyResult{OK: true, Stage: "data", Latency: time.Since(start).Milliseconds(), FirstByte: string(buf[:end])}
			}
		}
		if err != nil {
			break
		}
	}
	if headDone {
		if len(buf) == 0 {
			return XHTTPVerifyResult{Stage: "data", Latency: time.Since(start).Milliseconds(), Error: "下行无回包"}
		}
		return XHTTPVerifyResult{OK: true, Stage: "data", Latency: time.Since(start).Milliseconds()}
	}
	return XHTTPVerifyResult{Stage: stage, Latency: time.Since(start).Milliseconds(), Error: "下行无回包"}
}
