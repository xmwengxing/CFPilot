package scan

// 回填 / 取令牌的「直连失败自动走系统代理」策略。
//
// 真机故障（2026-11-25）：双 Pages 部署在部分网络下对 `*.pages.dev`
// 直连会 TLS 握手超时，而用户开着系统代理也没用 ——
// Go 只认环境变量，桌面版是 GUI 启动，拿不到用户 shell 里的环境变量。
//
// 这里的用例钉住三件事：
//  1. 直连在网络层失败 → 换系统代理重试，成功即返回；
//  2. 服务端给了答复（HTTP 4xx/5xx）→ **不重试**（换通路只会得到同样答复）；
//  3. 没有可用系统代理 → 保留直连的原始错误（不能变成「没有可用的系统代理」）。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/proxy"
)

// withProxyResolver 临时替换系统代理解析（返回 url 为空的 Resolver = 直连）。
func withProxyResolver(t *testing.T, raw string) {
	t.Helper()
	orig := proxyResolver
	t.Cleanup(func() { proxyResolver = orig })
	if raw == "" {
		proxyResolver = func() proxy.Resolver { return proxy.Resolver{Source: "测试：直连"} }
		return
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("代理地址无效：%v", err)
	}
	proxyResolver = func() proxy.Resolver {
		return proxy.Resolver{URL: u, Source: "测试代理"}
	}
}

// 直连连不上 → 用系统代理重试，代理回了 200 就算成功。
func TestPostResultsRetriesViaProxyWhenDirectFails(t *testing.T) {
	hit := make(chan string, 1)
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 走代理时请求行是绝对 URI（http://host/path）
		hit <- r.URL.String()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer proxySrv.Close()

	withProxyResolver(t, proxySrv.URL)

	// 127.0.0.1:1 一定是连接被拒（网络层失败）
	res := PostResultsTo(context.Background(), "http://127.0.0.1:1/api/v1/preferred-ips",
		"tok", []string{"1.2.3.4:443"}, "replace", TargetLocal, 3*time.Second)
	if !res.OK {
		t.Fatalf("代理重试应当成功，实际 %+v", res)
	}
	select {
	case got := <-hit:
		if got == "" {
			t.Error("代理应收到完整请求 URL")
		}
	case <-time.After(time.Second):
		t.Error("直连失败后没有走系统代理重试")
	}
}

// 服务端已给答复（401）→ 不能重试。
func TestPostResultsDoesNotRetryOnHTTPError(t *testing.T) {
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("bad token"))
	}))
	defer panel.Close()

	proxyHits := 0
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer proxySrv.Close()

	withProxyResolver(t, proxySrv.URL)

	res := PostResultsTo(context.Background(), panel.URL+"/api/v1/preferred-ips",
		"tok", []string{"1.2.3.4:443"}, "replace", TargetLocal, 3*time.Second)
	if res.OK {
		t.Fatal("401 不应算成功")
	}
	if proxyHits != 0 {
		t.Errorf("服务端已给答复时不应走代理重试，实际代理被调用 %d 次", proxyHits)
	}
}

// 没有可用系统代理 → 返回直连的原始错误（不能吞掉真实原因）。
func TestPostResultsKeepsDirectErrorWithoutProxy(t *testing.T) {
	withProxyResolver(t, "")

	res := PostResultsTo(context.Background(), "http://127.0.0.1:1/api/v1/preferred-ips",
		"tok", []string{"1.2.3.4:443"}, "replace", TargetLocal, 2*time.Second)
	if res.OK {
		t.Fatal("连不上时不应算成功")
	}
	if res.Error == "" || res.Error == "没有可用的系统代理" {
		t.Fatalf("应保留直连的真实错误，实际 %q", res.Error)
	}
}

// 直连连不上 → 代理也连不上：错误信息里要能看出「试过代理」。
func TestPostResultsReportsProxyRetryFailure(t *testing.T) {
	withProxyResolver(t, "http://127.0.0.1:1")

	res := PostResultsTo(context.Background(), "http://127.0.0.1:1/api/v1/preferred-ips",
		"tok", []string{"1.2.3.4:443"}, "replace", TargetLocal, 2*time.Second)
	if res.OK {
		t.Fatal("两次都失败时不应算成功")
	}
	if !contains(res.Error, "系统代理") {
		t.Errorf("错误信息应说明已尝试代理，实际 %q", res.Error)
	}
}

// 用户取消（ctx 已取消）→ 不重试，直接返回。
func TestShouldRetryViaProxySkipsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if shouldRetryViaProxy(ctx, context.Canceled) {
		t.Error("已取消的请求不应重试")
	}
	if shouldRetryViaProxy(context.Background(), nil) {
		t.Error("没有错误时不应重试")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
