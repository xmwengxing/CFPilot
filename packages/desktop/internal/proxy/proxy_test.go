package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"
)

// 环境变量优先级最高。
func TestResolvePrefersEnvProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:8888")

	r := Resolve()
	if r.URL == nil {
		t.Fatal("应该解析出代理地址")
	}
	if r.URL.Host != "127.0.0.1:9999" {
		t.Errorf("HTTPS_PROXY 应该优先，实际 %q", r.URL.Host)
	}
	if r.Source == "" {
		t.Error("应该说明来源")
	}
}

// 没写协议���写法要能解析（"127.0.0.1:7890"）。
func TestParseProxyURLWithoutScheme(t *testing.T) {
	u, err := parseProxyURL("127.0.0.1:7890")
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "http" || u.Host != "127.0.0.1:7890" {
		t.Errorf("实际 %s://%s", u.Scheme, u.Host)
	}
}

// 无效的代理地址要被跳过，不能让整个解析崩掉。
func TestParseProxyURLRejectsInvalid(t *testing.T) {
	for _, raw := range []string{"", "   ", "://"} {
		if _, err := parseProxyURL(raw); err == nil {
			t.Errorf("%q 应该解析失败", raw)
		}
	}
}

// 环境变量设了空值时应当被忽略。
func TestResolveIgnoresBlankEnv(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "   ")
	t.Setenv("HTTP_PROXY", "")
	// 结果取决于机器上有没有系统代理 —— 只断言「不崩」且 URL 要么空要么合法。
	r := Resolve()
	if r.URL != nil {
		if r.URL.Host == "" {
			t.Error("代理地址不该没有 host")
		}
	}
}

// ⚠️ 关键：代理**真的被用上了**（不是只解析对）。
//
// 起一个本地 HTTP 服务器当代理，请求一个不存在的域名 ——
// 只有走代理才会命中它。
func TestClientActuallyUsesProxy(t *testing.T) {
	var hit bool
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("via-proxy"))
	}))
	defer proxySrv.Close()

	proxyURL, err := url.Parse(proxySrv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resolver := Resolver{URL: proxyURL, Source: "测试"}
	client := resolver.Client(5 * time.Second)

	resp, err := client.Get("http://example.invalid/should-not-resolve")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if !hit {
		t.Fatal("请求没有经过代理 —— 代理没被用上")
	}
}

// 直连时不应该挂代理。
func TestClientWithoutProxyDoesNotSetTransport(t *testing.T) {
	resolver := Resolver{Source: "直连"}
	client := resolver.Client(5 * time.Second)
	if client.Transport != nil {
		t.Error("直连时不该设置 Transport")
	}
}

// 走代理时必须**克隆 DefaultTransport**再改 Proxy ——
// 直接 new 一个空 Transport 会丢掉连接池与默认超时等设定。
func TestClientClonesDefaultTransport(t *testing.T) {
	resolver := Resolver{URL: &url.URL{Scheme: "http", Host: "127.0.0.1:1"}, Source: "测试"}
	client := resolver.Client(time.Second)
	tr, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("Transport 类型不对")
	}
	if tr.Proxy == nil {
		t.Error("应该设置了 Proxy")
	}
	if tr.DialContext == nil && tr.DialTLSContext == nil {
		t.Error("克隆的 Transport 不该丢掉默认的拨号设置")
	}
}

// 环境变量与系统代理都拿不到时应当直连（而不是报错）。
func TestResolveFallsBackToDirect(t *testing.T) {
	// 清掉环境变量；系统代理是否存在取决于机器，无法断言 —— 只断言不崩。
	os.Unsetenv("HTTPS_PROXY")
	os.Unsetenv("HTTP_PROXY")
	_ = Resolve()
}
