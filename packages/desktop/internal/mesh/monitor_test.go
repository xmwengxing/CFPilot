package mesh

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 云监测台上报对齐 MobiHop node/monitor.rs：默认关闭、endpoint+token 才启用、
// 首次立即上报、字段与 Worker 的 /heartbeat 一一对应、令牌走请求头。
func TestSpawnMonitorSendsHeartbeat(t *testing.T) {
	type captured struct {
		token string
		hb    Heartbeat
	}
	ch := make(chan captured, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/heartbeat" {
			t.Errorf("上报路径 = %s, 期望 /heartbeat", r.URL.Path)
		}
		var hb Heartbeat
		if err := json.NewDecoder(r.Body).Decode(&hb); err != nil {
			t.Errorf("报文体解码失败: %v", err)
		}
		select {
		case ch <- captured{token: r.Header.Get("X-Monitor-Token"), hb: hb}:
		default:
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := Config{
		MonitoringEndpoint:   srv.URL,
		MonitoringToken:      "monitor-token-123",
		MonitoringIntervalMS: 60_000, // 大间隔：只验证「立即发第一次」
		MonitoringAlias:      "node-a",
		ClientVersion:        "0.50.0",
		Verbose:              false,
	}
	if !spawnMonitor(ctx, cfg, "0102030405060708", "10.97.0.1") {
		t.Fatal("endpoint+token 齐备时应启用上报")
	}
	select {
	case got := <-ch:
		if got.token != "monitor-token-123" {
			t.Errorf("X-Monitor-Token = %q", got.token)
		}
		if got.hb.NodeID != "0102030405060708" {
			t.Errorf("node_id = %q", got.hb.NodeID)
		}
		if got.hb.VirtualIPv4 != "10.97.0.1" {
			t.Errorf("virtual_ipv4 = %q", got.hb.VirtualIPv4)
		}
		if got.hb.Alias != "node-a" {
			t.Errorf("alias = %q", got.hb.Alias)
		}
		if got.hb.Version != "0.50.0" {
			t.Errorf("version = %q", got.hb.Version)
		}
		if !got.hb.Online {
			t.Error("online 应为 true")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("首次心跳应在启用后立即发出")
	}
}

func TestSpawnMonitorDisabledWithoutToken(t *testing.T) {
	cfg := Config{MonitoringEndpoint: "https://example.com", MonitoringToken: "  "}
	if spawnMonitor(context.Background(), cfg, "0102030405060708", "10.97.0.1") {
		t.Fatal("只配 endpoint 没有 token 时必须禁用（与 MobiHop 一致）")
	}
	cfg2 := Config{}
	if spawnMonitor(context.Background(), cfg2, "0102030405060708", "10.97.0.1") {
		t.Fatal("空配置必须默认关闭")
	}
}

func TestMonitorIntervalClamp(t *testing.T) {
	cases := []struct {
		in   int64
		want time.Duration
	}{
		{0, 30 * time.Second},
		{1000, 5 * time.Second},   // 低于 5s 抬到 5s
		{5000, 5 * time.Second},   // 边界保留
		{15000, 15 * time.Second}, // 正常值
	}
	for _, c := range cases {
		if got := monitorInterval(Config{MonitoringIntervalMS: c.in}); got != c.want {
			t.Errorf("interval(%d) = %v, 期望 %v", c.in, got, c.want)
		}
	}
}

func TestHeartbeatURL(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"https://m.example.com", "https://m.example.com/heartbeat"},
		{"https://m.example.com/", "https://m.example.com/heartbeat"},
		{"https://m.example.com///", "https://m.example.com/heartbeat"},
	} {
		if got := heartbeatURL(c.in); got != c.want {
			t.Errorf("heartbeatURL(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}
