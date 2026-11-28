package mesh

import (
	"fmt"
	"strings"
)

// W3：MetricsText 把状态快照渲染成 Prometheus 文本格式（0.0.4）。
//
// 为什么从 Status 渲染而不是另立一套计数器：Status 已经是面板 / CLI / 守护进程
// 共用的唯一快照，另建一份必然漂移。渲染是纯函数，便于单测直接断言每行内容。
//
// 暴露面刻意只覆盖「排查时真的会看」的项：帧分账、丢弃原因、hub 入口七类、
// 分账残差、健康档位、LSDB/路由规模。指标名一旦公开就是契约，改动要当兼容性变更看。
func MetricsText(st Status) string {
	var b strings.Builder

	up := 0
	if st.Running {
		up = 1
	}
	writeMetric(&b, "cfpilot_mesh_up", "gauge", "组网是否运行（1=运行）", "", up)
	writeMetric(&b, "cfpilot_mesh_uptime_seconds", "gauge", "本次组网已运行秒数", "", st.UptimeSec)

	b.WriteString("# HELP cfpilot_mesh_frames_total 收发帧数（按方向与链路类别分账）\n")
	b.WriteString("# TYPE cfpilot_mesh_frames_total counter\n")
	frame := func(direction, link string, v uint64) {
		fmt.Fprintf(&b, "cfpilot_mesh_frames_total{direction=%q,link=%q} %d\n", direction, link, v)
	}
	frame("tx", "total", st.TXFrames)
	frame("tx", "direct", st.TXDirect)
	frame("tx", "relayed", st.TXRelayed)
	frame("tx", "forwarded", st.TXForwarded)
	frame("rx", "total", st.RXFrames)
	frame("rx", "direct", st.RXDirect)
	frame("rx", "relayed", st.RXRelayed)

	b.WriteString("# HELP cfpilot_mesh_dropped_total 丢弃帧数（按方向与原因）\n")
	b.WriteString("# TYPE cfpilot_mesh_dropped_total counter\n")
	drop := func(direction, reason string, v uint64) {
		fmt.Fprintf(&b, "cfpilot_mesh_dropped_total{direction=%q,reason=%q} %d\n", direction, reason, v)
	}
	drop("tx", "total", st.TXDropped)
	drop("tx", "forward", st.ForwardDrop)
	if st.Drops != nil {
		drop("tx", "no_route", st.Drops.NoRoute)
		drop("tx", "ttl", st.Drops.TTL)
		drop("tx", "encode", st.Drops.Encode)
		drop("tx", "send_fail", st.Drops.SendFail)
		drop("tx", "unknown_vip", st.Drops.UnknownVIP)
		drop("tx", "bad_packet", st.Drops.BadPacket)
	}
	drop("rx", "total", st.RXDropped)
	if st.HubRX != nil {
		drop("rx", "queue_full", st.HubRX.QueueDrop)
	}

	if st.HubRX != nil {
		b.WriteString("# HELP cfpilot_mesh_hub_rx_datagrams_total hub 入口数据报（七类分账，total=七类和）\n")
		b.WriteString("# TYPE cfpilot_mesh_hub_rx_datagrams_total counter\n")
		hub := func(class string, v uint64) {
			fmt.Fprintf(&b, "cfpilot_mesh_hub_rx_datagrams_total{class=%q} %d\n", class, v)
		}
		hub("total", st.HubRX.Total)
		hub("direct", st.HubRX.Direct)
		hub("relay", st.HubRX.Relay)
		hub("discovered", st.HubRX.Discovered)
		hub("probe", st.HubRX.Probe)
		hub("control", st.HubRX.Control)
		hub("raw", st.HubRX.Raw)
		hub("malformed", st.HubRX.Malformed)
		writeMetric(&b, "cfpilot_mesh_hub_rx_unexplained", "gauge",
			"分账残差（rx_total-七类之和，应为 0；非 0 说明有帧被无计数吞掉）", "", st.HubRX.Unexplained())
	}

	writeMetric(&b, "cfpilot_mesh_handshake_ok_total", "counter", "完成握手的累计次数", "", st.HandshakeOK)
	writeMetric(&b, "cfpilot_mesh_probe_stale_total", "counter", "迟到/重复的探针回包数（不计入 RTT）", "", st.ProbeStale)
	writeMetric(&b, "cfpilot_mesh_lsdb_descriptors", "gauge", "描述符库条目数", "", st.LSDB)
	writeMetric(&b, "cfpilot_mesh_routes", "gauge", "转发表可达目的数", "", st.Routes)
	writeMetric(&b, "cfpilot_mesh_peers_total", "gauge", "对端条目数（含仅配置未连接）", "", len(st.Peers))
	online := 0
	for _, p := range st.Peers {
		if p.Online {
			online++
		}
	}
	writeMetric(&b, "cfpilot_mesh_peers_online", "gauge", "当前在线对端数", "", online)
	if st.Health != "" {
		b.WriteString("# HELP cfpilot_mesh_health 全部对端里最差的一档（1=当前档位）\n")
		b.WriteString("# TYPE cfpilot_mesh_health gauge\n")
		fmt.Fprintf(&b, "cfpilot_mesh_health{health=%q} 1\n", sanitizeLabel(st.Health))
	}
	if len(st.Peers) > 0 {
		b.WriteString("# HELP cfpilot_mesh_peer_health 单条链路健康档位（1=该档位）\n")
		b.WriteString("# TYPE cfpilot_mesh_peer_health gauge\n")
		for _, p := range st.Peers {
			health := p.Health
			if health == "" {
				health = HealthUnknown
			}
			fmt.Fprintf(&b, "cfpilot_mesh_peer_health{node_id=%q,via=%q,health=%q} 1\n",
				sanitizeLabel(p.NodeID), sanitizeLabel(p.Via), sanitizeLabel(health))
		}
	}
	return b.String()
}

// writeMetric 输出一个无标签的指标（带 HELP/TYPE）。
func writeMetric(b *strings.Builder, name, kind, help, labels string, value any) {
	fmt.Fprintf(b, "# HELP %s %s\n# TYPE %s %s\n%s%s %v\n", name, help, name, kind, name, labels, value)
}

// sanitizeLabel 去掉标签值里会破坏行格式的字符（引号、换行、反斜杠）。
// NodeID / via / health 都是内部生成，这里是防御性的最后一道。
func sanitizeLabel(v string) string {
	if !strings.ContainsAny(v, "\"\\\n\r") {
		return v
	}
	r := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "\n", " ", "\r", " ")
	return r.Replace(v)
}
