package scan

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func identityServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	return srv, roots
}

// 本地 TLS fixture 仅在测试中注入；导出入口仍强制校验服务地址。
func identifyEgress(ctx context.Context, options EgressIdentityOptions, roots *x509.CertPool) (EgressIdentityResult, error) {
	service, err := url.Parse(options.ServiceURL)
	if err != nil {
		return EgressIdentityResult{}, err
	}
	return requestEgressIdentity(ctx, options, service, roots)
}

func identityJSON(at time.Time) string {
	return `{"remote_ip":"8.8.4.4","observed_at":"` + at.Format(time.RFC3339Nano) + `","egress_kind":"user-proxy","colo":"NRT"}`
}

func TestIdentifyEgressDirectAndRedaction(t *testing.T) {
	at := time.Now().Add(-2 * time.Second)
	srv, roots := identityServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer secret" || r.URL.Query().Get("token") != "query-secret" {
			t.Errorf("请求协议错误：method=%s, authorization=%q, query=%q", r.Method, r.Header.Get("Authorization"), r.URL.RawQuery)
		}
		if r.Header.Get("Accept-Encoding") != "identity" || r.Header.Get("X-Forwarded-For") != "" {
			t.Error("请求不应压缩或携带转发地址")
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-Forwarded-For", "127.0.0.1")
		_, _ = io.WriteString(w, identityJSON(at))
	})
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	result, err := identifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: srv.URL + "/identify?token=query-secret", BearerToken: "secret"}, roots)
	if err != nil {
		t.Fatal(err)
	}
	if result.Transport != "direct" || result.RemoteIP != "8.8.4.4" || result.SourceURL != srv.URL+"/identify" || result.AgeMs < 2000 || result.AgeMs > 5000 || result.EgressKind != "user-proxy" || result.Colo != "NRT" || !result.ObservedAt.Equal(at) || result.FetchedAt.Location() != time.UTC {
		t.Fatalf("识别结果错误：%+v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"remoteIp", "observedAt", "fetchedAt", "ageMs", "sourceUrl", "egressKind"} {
		if !strings.Contains(string(encoded), `"`+field+`"`) {
			t.Errorf("缺少 JSON 字段 %s", field)
		}
	}
	if strings.Contains(string(encoded), "secret") {
		t.Fatal("结果包含敏感凭据")
	}
}

func TestIdentifyEgressRejectsInvalidResponses(t *testing.T) {
	valid := identityJSON(time.Now())
	cases := []struct {
		name, body, media, encoding string
		status                      int
	}{
		{"status", valid, "application/json", "", 201},
		{"redirect", valid, "application/json", "", 302},
		{"html", valid, "text/html", "", 200},
		{"compression", valid, "application/json", "gzip", 200},
		{"large", strings.Repeat(" ", EgressIdentityMaxBody+1), "application/json", "", 200},
		{"json", "{", "application/json", "", 200},
		{"trailing", valid + "{}", "application/json", "", 200},
		{"null", "null", "application/json", "", 200},
		{"private", strings.Replace(valid, "8.8.4.4", "10.0.0.1", 1), "application/json", "", 200},
		{"future", identityJSON(time.Now().Add(time.Minute)), "application/json", "", 200},
		{"stale", identityJSON(time.Now().Add(-6 * time.Minute)), "application/json", "", 200},
		{"time", strings.Replace(valid, "observed_at", "missing_time", 1), "application/json", "", 200},
		{"text", strings.Replace(valid, "user-proxy", `bad\ttext`, 1), "application/json", "", 200},
		{"length", strings.Replace(valid, "user-proxy", strings.Repeat("x", 129), 1), "application/json", "", 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, roots := identityServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.media)
				w.Header().Set("Content-Encoding", tc.encoding)
				w.Header().Set("Location", "/secret")
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			if result, err := identifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: srv.URL}, roots); err == nil {
				t.Fatalf("应拒绝响应：%+v", result)
			}
		})
	}
}

func TestIdentifyEgressValidatesPublicIP(t *testing.T) {
	for _, ip := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if _, err := validatePublicIP(ip); err != nil {
			t.Errorf("应接受 %s: %v", ip, err)
		}
	}
	for _, ip := range []string{"", "example.com", "8.8.8.8:443", " 8.8.8.8", "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.1.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1", "fe80::1", "fe80::1%eth0", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:192.0.2.1"} {
		if _, err := validatePublicIP(ip); err == nil {
			t.Errorf("应拒绝 %s", ip)
		}
	}
}

func TestIdentifyEgressServiceAddressBoundary(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.1.1", "240.0.0.1", "[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[2001:db8::1]", "localhost", "localhost.", "service.local"} {
		if _, err := validateIdentityURL("https://" + host + "/identify"); err == nil {
			t.Errorf("应拒绝非公网服务 %s", host)
		}
	}
	for _, host := range []string{"8.8.8.8", "[2606:4700:4700::1111]", "identify.example.com"} {
		if _, err := validateIdentityURL("https://" + host + "/identify"); err != nil {
			t.Errorf("应接受公网服务 %s: %v", host, err)
		}
	}
}

func TestIdentifyEgressValidatesConfiguration(t *testing.T) {
	for _, raw := range []string{"", "http://example.com", "https://user:password@example.com", "https://example.com/#secret", "https://example.com:0", "https://example.com:65536"} {
		if _, err := IdentifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: raw}); err == nil {
			t.Errorf("应拒绝 %q", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:1080", "socks5://127.0.0.1", "socks5://127.0.0.1:0", "socks5://127.0.0.1:1080/path", "socks5://127.0.0.1:1080?secret=x"} {
		if _, err := IdentifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: "https://example.com", SOCKS5ProxyURL: raw}); err == nil {
			t.Errorf("应拒绝代理 %q", raw)
		}
	}
	_, err := IdentifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: "https://example.com?secret=query-secret", BearerToken: "bad\r\nsecret"})
	if err == nil || strings.Contains(err.Error(), "query-secret") || strings.Contains(err.Error(), "bad") {
		t.Fatalf("令牌错误未被安全拒绝：%v", err)
	}
}

func TestIdentifyEgressCancellationAndTLS(t *testing.T) {
	srv, roots := identityServer(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := identifyEgress(ctx, EgressIdentityOptions{ServiceURL: srv.URL + "?secret=query-secret"}, roots)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second || strings.Contains(err.Error(), "query-secret") {
		t.Fatalf("取消未生效或泄露 query：%v", err)
	}
	good, _ := identityServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, identityJSON(time.Now()))
	})
	if _, err := identifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: good.URL}, nil); err == nil {
		t.Fatal("不得跳过 TLS 证书校验")
	}
}

// 测试代理只转发到本地 TLS 服务，记录 CONNECT 的域名以验证代理端解析语义。
func identitySOCKSProxy(t *testing.T, target string, auth bool) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	calls := &atomic.Int32{}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 2)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return
		}
		methods := make([]byte, int(buf[1]))
		if _, err := io.ReadFull(conn, methods); err != nil {
			return
		}
		method := byte(0)
		if auth {
			method = 2
		}
		_, _ = conn.Write([]byte{5, method})
		if auth {
			if _, err := io.ReadFull(conn, buf); err != nil {
				return
			}
			user := make([]byte, int(buf[1]))
			if _, err := io.ReadFull(conn, user); err != nil {
				return
			}
			one := make([]byte, 1)
			if _, err := io.ReadFull(conn, one); err != nil {
				return
			}
			pass := make([]byte, int(one[0]))
			if _, err := io.ReadFull(conn, pass); err != nil {
				return
			}
			if string(user) != "user" || string(pass) != "password" {
				t.Error("SOCKS5 凭据未传递")
				_, _ = conn.Write([]byte{1, 1})
				return
			}
			_, _ = conn.Write([]byte{1, 0})
		}
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return
		}
		if header[3] != 3 {
			t.Error("目标域名未交给代理解析")
			return
		}
		one := make([]byte, 1)
		if _, err := io.ReadFull(conn, one); err != nil {
			return
		}
		destination := make([]byte, int(one[0])+2)
		if _, err := io.ReadFull(conn, destination); err != nil {
			return
		}
		if string(destination[:len(destination)-2]) != "example.com" {
			t.Error("代理目标域名错误")
			return
		}
		upstream, err := net.Dial("tcp", target)
		if err != nil {
			return
		}
		defer upstream.Close()
		calls.Add(1)
		_, _ = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		_ = conn.SetDeadline(time.Time{})
		go func() { _, _ = io.Copy(upstream, conn); _ = upstream.Close() }()
		_, _ = io.Copy(conn, upstream)
	}()
	return "socks5://" + ln.Addr().String(), calls
}

func TestIdentifyEgressSOCKS5(t *testing.T) {
	for _, auth := range []bool{false, true} {
		t.Run(strconv.FormatBool(auth), func(t *testing.T) {
			srv, roots := identityServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, identityJSON(time.Now().Add(-time.Second)))
			})
			u, _ := url.Parse(srv.URL)
			proxy, calls := identitySOCKSProxy(t, u.Host, auth)
			if auth {
				proxy = strings.Replace(proxy, "socks5://", "socks5://user:password@", 1)
			}
			_, port, _ := net.SplitHostPort(u.Host)
			result, err := identifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: "https://example.com:" + port + "/identify", SOCKS5ProxyURL: proxy}, roots)
			if err != nil {
				t.Fatal(err)
			}
			if result.Transport != "socks5" || calls.Load() != 1 {
				t.Fatalf("未经指定代理：%+v", result)
			}
		})
	}
}

func TestIdentifyEgressStalledBodyCancellation(t *testing.T) {
	srv, roots := identityServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := identifyEgress(ctx, EgressIdentityOptions{ServiceURL: srv.URL}, roots)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("慢响应体未及时取消：%v", err)
	}
}

func TestIdentifyEgressSOCKS5HandshakeCancellation(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	closed := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			close(closed)
			return
		}
		defer conn.Close()
		_, _ = io.Copy(io.Discard, conn)
		close(closed)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = IdentifyEgress(ctx, EgressIdentityOptions{ServiceURL: "https://example.com", SOCKS5ProxyURL: "socks5://" + ln.Addr().String()})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("SOCKS5 握手未及时取消：%v", err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("取消后 SOCKS5 连接未关闭")
	}
}

func TestIdentifyEgressSOCKS5DoesNotFallback(t *testing.T) {
	var called atomic.Int32
	srv, roots := identityServer(t, func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, identityJSON(time.Now()))
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := ln.Addr().String()
	_ = ln.Close()
	if _, err := identifyEgress(context.Background(), EgressIdentityOptions{ServiceURL: srv.URL + "?token=secret", SOCKS5ProxyURL: "socks5://" + address}, roots); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("代理失败处理错误：%v", err)
	}
	if called.Load() != 0 {
		t.Fatal("代理失败时发生静默直连")
	}
}
