package relay

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveRelayProbe 真机对照：用真实数据面验证「隧道 + 客户端 TLS」这条路。
//
// 单测里跑的是自签证书的假服务端，只能证明帧与协议实现自洽；
// 证书校验、VLESS 鉴权、Cloudflare 边缘按 SNI 路由这些**只有真机能验**。
//
// 用法：
//
//	CFPILOT_LIVE_HOST=data.example.com \
//	CFPILOT_LIVE_WS_PATH=/xxxx \
//	CFPILOT_LIVE_UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
//	CFPILOT_LIVE_IP=1.2.3.4 \
//	go test ./internal/relay/ -run TestLiveRelayProbe -v
func TestLiveRelayProbe(t *testing.T) {
	host := liveEnv(t, "CFPILOT_LIVE_HOST")
	wsPath := liveEnv(t, "CFPILOT_LIVE_WS_PATH")
	uuid := liveEnv(t, "CFPILOT_LIVE_UUID")
	ip := liveEnv(t, "CFPILOT_LIVE_IP")

	expected, err := FetchExpectedBuild(context.Background(), host, 15*time.Second)
	if err != nil {
		t.Fatalf("读不到数据面版本：%v", err)
	}
	t.Logf("数据面 %s，期望 build=%s，候选=%s", host, expected, ip)

	result := Probe(context.Background(), Options{
		Host:          host,
		WSPath:        wsPath,
		UUID:          uuid,
		ExpectedBuild: expected,
		Timeout:       15 * time.Second,
	}, ip)

	t.Logf("结果：ok=%v buildOk=%v status=%d build=%q 隧道=%dms TLS=%dms HTTP=%dms err=%q",
		result.OK, result.BuildOK, result.Status, result.Build,
		result.TunnelMs, result.TLSMs, result.HTTPMs, result.Error)

	if !result.OK {
		t.Fatalf("TLS 应通过（证书按 %s 校验）：%s", host, result.Error)
	}
	if !result.BuildOK {
		t.Fatalf("落点应是本实例：期望 %s，实际 %q", expected, result.Build)
	}
}

// liveEnv 读环境变量，缺失时跳过（与既有 live_* 用例同一套约定）。
func liveEnv(t *testing.T, key string) string {
	t.Helper()
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		t.Skipf("未设置 %s，跳过真机用例", key)
	}
	return v
}
