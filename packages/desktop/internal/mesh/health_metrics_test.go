package mesh

import (
	"strings"
	"testing"
	"time"
)

func TestProbeHealthTiers(t *testing.T) {
	cases := []struct {
		name     string
		lastPong time.Duration
		loss     float64
		samples  uint32
		want     string
	}{
		{"无样本不判故障", time.Second, 0, 0, HealthUnknown},
		{"刚连上新鲜 Pong", time.Second, 0, 3, HealthGreen},
		{"样本不足时丢包阈值不生效", time.Second, 0.9, 3, HealthGreen},
		{"Pong 超过 5s", 6 * time.Second, 0, 10, HealthYellow},
		{"Pong 超过 15s", 16 * time.Second, 0, 10, HealthRed},
		{"丢包达一半", time.Second, 0.5, 10, HealthRed},
		{"丢包 20%", time.Second, 0.2, 10, HealthYellow},
		{"丢包 10%", time.Second, 0.1, 10, HealthGreen},
		{"Pong 更旧时以 age 为准", 16 * time.Second, 0.6, 3, HealthRed},
	}
	for _, c := range cases {
		if got := probeHealth(c.lastPong, c.loss, c.samples); got != c.want {
			t.Errorf("%s: probeHealth(%v, %.2f, %d) = %q，期望 %q", c.name, c.lastPong, c.loss, c.samples, got, c.want)
		}
	}
}

func TestAggregateHealth(t *testing.T) {
	peers := func(hs ...string) []Peer {
		out := make([]Peer, 0, len(hs))
		for _, h := range hs {
			out = append(out, Peer{Health: h})
		}
		return out
	}
	cases := []struct {
		name string
		in   []Peer
		want string
	}{
		{"空列表", peers(), HealthUnknown},
		{"全 unknown", peers(HealthUnknown, HealthUnknown), HealthUnknown},
		{"unknown 不压过 green", peers(HealthUnknown, HealthGreen), HealthGreen},
		{"yellow 优先于 green", peers(HealthGreen, HealthYellow), HealthYellow},
		{"red 最差", peers(HealthGreen, HealthYellow, HealthRed), HealthRed},
	}
	for _, c := range cases {
		if got := aggregateHealth(c.in); got != c.want {
			t.Errorf("%s: aggregateHealth = %q，期望 %q", c.name, got, c.want)
		}
	}
}

func TestMetricsTextRendersStatus(t *testing.T) {
	st := Status{
		Running: true, UptimeSec: 42,
		TXFrames: 10, TXDirect: 7, TXRelayed: 3, TXForwarded: 2,
		RXFrames: 8, RXDirect: 5, RXRelayed: 3,
		TXDropped: 4, RXDropped: 1, ForwardDrop: 1,
		HandshakeOK: 2, ProbeStale: 1, LSDB: 3, Routes: 2,
		Health: HealthYellow,
		HubRX:  &HubRxStats{Total: 5, Direct: 3, Relay: 1, Probe: 1, QueueDrop: 2},
		Drops:  &DropStats{NoRoute: 2, TTL: 1, Encode: 0, SendFail: 1, UnknownVIP: 3, BadPacket: 1},
		Peers: []Peer{
			{NodeID: "aa", Via: "udp", Health: HealthGreen, Online: true},
			{NodeID: "bb", Via: "wss", Health: HealthYellow, Online: false},
		},
	}
	out := MetricsText(st)
	wants := []string{
		"cfpilot_mesh_up 1",
		"cfpilot_mesh_uptime_seconds 42",
		"cfpilot_mesh_frames_total{direction=\"tx\",link=\"direct\"} 7",
		"cfpilot_mesh_frames_total{direction=\"rx\",link=\"relayed\"} 3",
		"cfpilot_mesh_dropped_total{direction=\"tx\",reason=\"no_route\"} 2",
		"cfpilot_mesh_dropped_total{direction=\"rx\",reason=\"queue_full\"} 2",
		"cfpilot_mesh_hub_rx_datagrams_total{class=\"total\"} 5",
		"cfpilot_mesh_hub_rx_datagrams_total{class=\"probe\"} 1",
		"cfpilot_mesh_hub_rx_unexplained 0",
		"cfpilot_mesh_peers_total 2",
		"cfpilot_mesh_peers_online 1",
		"cfpilot_mesh_health{health=\"yellow\"} 1",
		"cfpilot_mesh_peer_health{node_id=\"aa\",via=\"udp\",health=\"green\"} 1",
	}
	for _, want := range wants {
		if !strings.Contains(out, want) {
			t.Errorf("指标输出缺少 %q\n---\n%s", want, out)
		}
	}
	// HELP 与 TYPE 必须成对出现，否则抓取端会丢弃该指标族。
	if h, ty := strings.Count(out, "# HELP "), strings.Count(out, "# TYPE "); h != ty {
		t.Errorf("HELP(%d) 与 TYPE(%d) 数量不一致", h, ty)
	}
	// 每个非注释行都必须有值（Prometheus 文本格式要求）。
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.Contains(line, " ") {
			t.Errorf("指标行缺少取值: %q", line)
		}
	}
}

func TestMetricsTextHandlesNilSubsystems(t *testing.T) {
	out := MetricsText(Status{})
	if !strings.Contains(out, "cfpilot_mesh_up 0") {
		t.Fatalf("未运行时应输出 up 0，实际:\n%s", out)
	}
	if strings.Contains(out, "cfpilot_mesh_peer_health") {
		t.Fatalf("没有对端时不应输出 per-peer 指标")
	}
	if strings.Contains(out, "cfpilot_mesh_hub_rx_datagrams_total") {
		t.Fatalf("hub 未运行时不应输出 hub 分账")
	}
}

// TestMetricsTextSanitizesLabels 确认标签值里的引号/换行不会破坏行结构。
func TestMetricsTextSanitizesLabels(t *testing.T) {
	st := Status{Peers: []Peer{{NodeID: "a\"b", Via: "udp\nX", Health: HealthGreen}}}
	out := MetricsText(st)
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "cfpilot_mesh_peer_health{") {
			if strings.Count(line, "{") != 1 {
				t.Fatalf("标签未被清理: %q", line)
			}
			return
		}
	}
	t.Fatalf("未找到 per-peer 指标:\n%s", out)
}
