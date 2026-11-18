package mesh

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// 云监测台上报（对齐 MobiHop crates/mobihop-node/src/monitor.rs）。
//
// 语义与 MobiHop 完全一致：
//   - **默认关闭**：只有 MonitoringEndpoint 与 MonitoringToken 都非空才启用；
//   - 周期 POST `<endpoint>/heartbeat`，头 `X-Monitor-Token`；
//   - 间隔默认 30s、最低 5s（低于 5s 按 5s）；
//   - 报文体：node_id（16 hex）/ alias / virtual_ipv4 / version / online；
//   - 只从**设备端**主动上报；Worker 端 `/devices` 读 D1（监测台轮询）；
//   - 失败只记日志（Verbose 时），绝不阻断组网；token 不写日志。
//
// 为什么默认关闭：上报会把「节点在线、IP、版本」送到第三方 Worker，
// 属于用户可感知的隐私边界，必须显式开启。
const (
	DefaultMonitorIntervalMS = 30_000
	MinMonitorIntervalMS     = 5_000
	monitorHTTPTimeout       = 10 * time.Second
)

// Heartbeat 是 `/heartbeat` 的报文体（字段名必须与 Worker 的 handleHeartbeat 一致）。
type Heartbeat struct {
	NodeID      string `json:"node_id"`
	Alias       string `json:"alias,omitempty"`
	VirtualIPv4 string `json:"virtual_ipv4,omitempty"`
	Version     string `json:"version"`
	Online      bool   `json:"online"`
}

// monitorEnabled 报告配置是否足以启用上报（对齐 maybe_spawn 的判定）。
func monitorEnabled(cfg Config) bool {
	return strings.TrimSpace(cfg.MonitoringEndpoint) != "" && strings.TrimSpace(cfg.MonitoringToken) != ""
}

// heartbeatURL 拼接上报地址（去掉尾部斜杠，避免出现 `//heartbeat`）。
func heartbeatURL(endpoint string) string {
	return strings.TrimRight(strings.TrimSpace(endpoint), "/") + "/heartbeat"
}

// monitorInterval 返回上报间隔（默认 30s、最低 5s）。
func monitorInterval(cfg Config) time.Duration {
	ms := cfg.MonitoringIntervalMS
	if ms <= 0 {
		ms = DefaultMonitorIntervalMS
	}
	if ms < MinMonitorIntervalMS {
		ms = MinMonitorIntervalMS
	}
	return time.Duration(ms) * time.Millisecond
}

// monitorAlias 返回上报显示名：配置 > 主机名 > 空。
func monitorAlias(cfg Config) string {
	if a := strings.TrimSpace(cfg.MonitoringAlias); a != "" {
		return a
	}
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return ""
}

// spawnMonitor 启动上报循环；返回是否真正启用。
//
// ctx 取消时循环退出（与 Lifecycle 生命周期绑定）。
func spawnMonitor(ctx context.Context, cfg Config, nodeID, virtualIP string) bool {
	endpoint := strings.TrimSpace(cfg.MonitoringEndpoint)
	token := strings.TrimSpace(cfg.MonitoringToken)
	if endpoint == "" {
		return false
	}
	if token == "" {
		// 与 MobiHop 一致：只配了地址没配令牌 → 明确告警并禁用（不静默半开）。
		log.Printf("[mesh] 已配置 monitoringEndpoint 但缺少 monitoringToken，云监测上报已禁用")
		return false
	}

	interval := monitorInterval(cfg)
	version := strings.TrimSpace(cfg.ClientVersion)
	if version == "" {
		version = "cfpilot"
	}
	hb := Heartbeat{
		NodeID:      nodeID,
		Alias:       monitorAlias(cfg),
		VirtualIPv4: virtualIP,
		Version:     version,
		Online:      true,
	}
	url := heartbeatURL(endpoint)
	client := &http.Client{Timeout: monitorHTTPTimeout}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// 与 MobiHop 的 tokio interval 一致：**立即发第一次**，之后按间隔。
		send := func() {
			body, err := json.Marshal(hb)
			if err != nil {
				return
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Monitor-Token", token)
			resp, err := client.Do(req)
			if err != nil {
				if cfg.Verbose && ctx.Err() == nil {
					log.Printf("[mesh] 云监测上报失败: %v", err)
				}
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				if cfg.Verbose && ctx.Err() == nil {
					log.Printf("[mesh] 云监测上报被拒: HTTP %d", resp.StatusCode)
				}
			}
		}
		send()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				send()
			}
		}
	}()
	return true
}
