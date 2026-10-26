package scan

import (
	"context"
	"testing"
	"time"
)

// 真机：用真实的 pages.dev 域名 + 真实 WS 路径验证 101。
func TestLiveWS101(t *testing.T) {
	host := getenvOrSkip(t, "CFPILOT_LIVE_HOST")
	path := getenvOrSkip(t, "CFPILOT_LIVE_PATH")
	ip := getenvOrSkip(t, "CFPILOT_LIVE_IP")

	t.Logf("host=%s path=%s ip=%s", host, path, ip)

	// 测两种路径：用户配的 WS 路径 vs 探针路径
	for _, p := range []string{path, "/__edge_probe"} {
		res := ProbeWS101(context.Background(), ip, 443, host, 8*time.Second, p)
		t.Logf("  path=%-20s OK=%v status=%d colo=%q err=%q",
			p, res.OK, res.Status, res.Colo, res.Error)
	}
}
