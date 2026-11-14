package relay

// 校验网址（终检）的单元测试。
//
// 守护的语义：
//   - 内置清单豁免 DNS 剔除（国内本地 DNS 会把 CF 站点解析到本地 CDN，
//     运行时剔除会误杀内置清单）；
//   - 用户手填的网址按解析结果剔除非 CF 网段（防「拿百度校验反代」）；
//   - CF 网段判定的基本正确性。

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func TestIsCloudflareIPv4(t *testing.T) {
	for _, ip := range []string{"104.16.132.229", "172.64.154.211", "162.159.140.229", "188.114.96.5", "1.1.1.1"} {
		if !isCloudflareIPv4(ip) {
			t.Errorf("%s 应判定为 CF 网段", ip)
		}
	}
	for _, ip := range []string{"151.101.194.146", "8.8.8.8", "1.2.3.4", "39.109.122.128", ""} {
		if isCloudflareIPv4(ip) {
			t.Errorf("%s 不应判定为 CF 网段", ip)
		}
	}
}

func TestResolveVerifyHostsDefaults(t *testing.T) {
	// 用户没填 → 直接用内置清单（不触发任何 DNS）
	got := ResolveVerifyHosts(nil, nil)
	if len(got) == 0 {
		t.Fatal("内置清单不应为空")
	}
	if len(got) > 3 {
		t.Errorf("终检网址上限 3 个，实际 %d", len(got))
	}
	if got[0] != "cloudflare.com" {
		t.Errorf("内置清单第一个应是 cloudflare.com，实际 %q", got[0])
	}
}

func TestResolveVerifyHostsFiltersNonCF(t *testing.T) {
	// 注入假解析：baidu.com 全部解析到非 CF 段 → 剔除；
	// openai.com 解析到 CF 段 → 保留。
	old := verifyHostLookup
	verifyHostLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		switch host {
		case "baidu.com":
			return []net.IPAddr{{IP: net.IPv4(180, 76, 76, 76)}}, nil
		case "openai.com":
			return []net.IPAddr{{IP: net.IPv4(104, 18, 33, 45)}}, nil
		}
		return nil, &net.DNSError{Err: "no such host", Name: host}
	}
	t.Cleanup(func() { verifyHostLookup = old })

	var logs []string
	got := ResolveVerifyHosts([]string{"baidu.com", "openai.com"}, func(msg string) { logs = append(logs, msg) })
	joined := strings.Join(got, ",")
	if strings.Contains(joined, "baidu.com") {
		t.Errorf("非 CF 网段网址应被剔除，实际 %q", joined)
	}
	if !strings.Contains(joined, "openai.com") {
		t.Errorf("CF 网段网址应保留，实际 %q", joined)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "已剔除校验网址 baidu.com") {
		t.Errorf("剔除原因应回传日志，实际 %v", logs)
	}
}

func TestResolveVerifyHostsBuiltinExempt(t *testing.T) {
	// 内置清单里的 host 豁免 DNS 剔除：即使解析失败也保留。
	old := verifyHostLookup
	verifyHostLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		return nil, &net.DNSError{Err: "dns poisoned", Name: host, IsNotFound: true}
	}
	t.Cleanup(func() { verifyHostLookup = old })

	got := ResolveVerifyHosts([]string{"cloudflare.com"}, nil)
	found := false
	for _, h := range got {
		if h == "cloudflare.com" {
			found = true
		}
	}
	if !found {
		t.Errorf("内置清单应豁免 DNS 剔除，实际 %v", got)
	}
}

// 终检超时不能拖死整轮体检。
func TestVerifyForwardingTimeout(t *testing.T) {
	// 不可达地址 → 在 opt.Timeout 内快速失败（不是永久挂起）
	opt := Options{
		Host:    "invalid.data-plane.invalid",
		WSPath:  "/ws",
		UUID:    "00000000-0000-4000-8000-000000000000",
		Timeout: 2 * time.Second,
	}
	start := time.Now()
	_, err := verifyForwarding(context.Background(), opt, "203.0.113.1", "cloudflare.com")
	if err == nil {
		t.Fatal("不可达目标应返回错误")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("终检应在超时约束内返回，实际 %v", elapsed)
	}
}
