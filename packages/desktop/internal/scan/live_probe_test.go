package scan

import (
	"context"
	"testing"
	"time"
)

// 真机测试：用真实的 Cloudflare 域名/IP 验证 TLS 探测。
// 需要设置 CFPILOT_LIVE_HOST 环境变量（如 next.xmdongyao.de5.net）
func TestLiveTLSProbe(t *testing.T) {
	host := getenvOrSkip(t, "CFPILOT_LIVE_HOST")
	ip := getenvOrSkip(t, "CFPILOT_LIVE_IP")

	t.Logf("host=%s ip=%s", host, ip)

	res := ProbeTLS(context.Background(), ip, 443, host, 8*time.Second)
	t.Logf("OK=%v TLSMs=%d ALPN=%q Error=%q", res.OK, res.TLSMs, res.ALPN, res.Error)

	if !res.OK {
		t.Fatalf("TLS 握手失败：%s", res.Error)
	}
}
