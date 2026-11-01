package scan

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	EgressIdentityTimeout         = 8 * time.Second
	EgressIdentityMaxBody         = 16 << 10
	EgressIdentityFutureTolerance = 30 * time.Second
	EgressIdentityMaxAge          = 5 * time.Minute
)

// EgressIdentityOptions 的服务地址和认证凭据仅用于本次请求，不写入档案。
// 对照 CLI 的实验性出口识别协议；这里识别指定传输路径，并非逐候选入口。
type EgressIdentityOptions struct {
	ServiceURL  string
	BearerToken string
	// 空值显式直连，不读取环境代理；代理失败时绝不回退直连。
	SOCKS5ProxyURL string
}

// EgressIdentityResult 记录识别服务的观测时间与本机获取时间；不参与默认 Run。
type EgressIdentityResult struct {
	Transport  string    `json:"transport"`
	FetchedAt  time.Time `json:"fetchedAt"`
	AgeMs      int64     `json:"ageMs"`
	RemoteIP   string    `json:"remoteIp"`
	ObservedAt time.Time `json:"observedAt"`
	EgressKind string    `json:"egressKind,omitempty"`
	Colo       string    `json:"colo,omitempty"`
	SourceURL  string    `json:"sourceUrl"`
}

type egressIdentityResponse struct {
	RemoteIP   string `json:"remote_ip"`
	ObservedAt string `json:"observed_at"`
	EgressKind string `json:"egress_kind"`
	Colo       string `json:"colo"`
}

// IdentifyEgress 请求用户自有 HTTPS 服务。remote_ip 必须由服务根据连接对端提供，
// 客户端不发送也不采信 X-Forwarded-For。Bearer 和查询参数不进入结果或错误。
// 拒绝非公网 IP 字面量；域名由用户信任，不提供 DNS 重绑定防护。
func IdentifyEgress(ctx context.Context, options EgressIdentityOptions) (EgressIdentityResult, error) {
	service, err := validateIdentityURL(options.ServiceURL)
	if err != nil {
		return EgressIdentityResult{}, err
	}
	return requestEgressIdentity(ctx, options, service, nil)
}

func requestEgressIdentity(ctx context.Context, options EgressIdentityOptions, service *url.URL, roots *x509.CertPool) (EgressIdentityResult, error) {
	if strings.ContainsFunc(options.BearerToken, unicode.IsControl) {
		return EgressIdentityResult{}, errors.New("出口识别认证令牌含控制字符")
	}
	transportName := "direct"
	transport := &http.Transport{DisableCompression: true, TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, MaxResponseHeaderBytes: EgressIdentityMaxBody}
	if options.SOCKS5ProxyURL != "" {
		proxy, err := validateIdentityProxy(options.SOCKS5ProxyURL)
		if err != nil {
			return EgressIdentityResult{}, err
		}
		// 标准库 SOCKS5 拨号将域名交给代理解析，并对请求取消与超时关闭握手连接。
		transport.Proxy = http.ProxyURL(proxy)
		transportName = "socks5"
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: EgressIdentityTimeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	requestCtx, cancel := context.WithTimeout(ctx, EgressIdentityTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, service.String(), nil)
	if err != nil {
		return EgressIdentityResult{}, errors.New("出口识别服务地址无效")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Cache-Control", "no-cache")
	if options.BearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+options.BearerToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		// url.Error 包含完整请求地址，可能泄露 query 内的密钥。
		if requestCtx.Err() != nil {
			return EgressIdentityResult{}, fmt.Errorf("请求出口识别服务中断：%w", requestCtx.Err())
		}
		return EgressIdentityResult{}, errors.New("请求出口识别服务失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return EgressIdentityResult{}, fmt.Errorf("出口识别服务返回 HTTP %d", resp.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return EgressIdentityResult{}, errors.New("出口识别响应必须是 application/json")
	}
	if encoding := strings.TrimSpace(resp.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return EgressIdentityResult{}, errors.New("出口识别响应不允许压缩")
	}
	if resp.ContentLength > EgressIdentityMaxBody {
		return EgressIdentityResult{}, errors.New("出口识别响应超过 16 KiB 限制")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, EgressIdentityMaxBody+1))
	if err != nil {
		if requestCtx.Err() != nil {
			return EgressIdentityResult{}, fmt.Errorf("读取出口识别响应中断：%w", requestCtx.Err())
		}
		return EgressIdentityResult{}, errors.New("读取出口识别响应失败")
	}
	if len(body) > EgressIdentityMaxBody {
		return EgressIdentityResult{}, errors.New("出口识别响应超过 16 KiB 限制")
	}
	var payload egressIdentityResponse
	if !utf8.Valid(body) || json.Unmarshal(body, &payload) != nil {
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
	return EgressIdentityResult{Transport: transportName, FetchedAt: fetched, AgeMs: age, RemoteIP: remoteIP, ObservedAt: observed.UTC(), EgressKind: strings.TrimSpace(payload.EgressKind), Colo: strings.TrimSpace(payload.Colo), SourceURL: service.String()}, nil
}

func validateIdentityURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("出口识别服务必须是 HTTPS URL，且不得包含用户信息或片段")
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("出口识别服务端口无效")
		}
	}
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil {
		if _, err := validatePublicIP(ip.String()); err != nil {
			return nil, errors.New("出口识别服务不能使用非公网 IP")
		}
	} else if host := strings.ToLower(strings.TrimSuffix(u.Hostname(), ".")); host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return nil, errors.New("出口识别服务不能使用本地地址")
	}
	return u, nil
}

func validateIdentityProxy(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "socks5" && u.Scheme != "socks5h") || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("SOCKS5 代理地址无效")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("SOCKS5 代理端口无效")
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if len(u.User.Username()) == 0 || len(u.User.Username()) > 255 || len(password) > 255 {
			return nil, errors.New("SOCKS5 代理凭据长度无效")
		}
	}
	return u, nil
}

// 除私网/回环/链路本地外，也排除共享地址、文档、测试和保留地址空间。
var identityNonPublic = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001:10::/28"),
}

func validatePublicIP(raw string) (string, error) {
	ip, err := netip.ParseAddr(raw)
	if err != nil || ip.Zone() != "" {
		return "", errors.New("出口识别服务返回的 remote_ip 不是公网 IP")
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
		return "", errors.New("出口识别服务返回的 remote_ip 不是公网 IP")
	}
	for _, prefix := range identityNonPublic {
		if prefix.Contains(ip) {
			return "", errors.New("出口识别服务返回的 remote_ip 不是公网 IP")
		}
	}
	return ip.String(), nil
}

func validIdentityText(value string) bool {
	return utf8.RuneCountInString(value) <= 128 && !strings.ContainsFunc(value, unicode.IsControl)
}
