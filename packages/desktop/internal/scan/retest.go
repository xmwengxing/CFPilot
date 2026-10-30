package scan

// 单 IP 可用性复测（桌面版「优选历史 → 重新测试选中」用）。
//
// ## 为什么需要
//
// 优选出来的 IP 是「某个时刻」的结论：机房会调路由、节点会临时下线、
// 订阅下发后用户想确认「现在还活着吗」。
// 这里复用阶段一/二/三的**同一套探测原语**（ProbeTCP / ProbeTLS /
// ProbeWS101 / MeasureThroughput），对单个 IP 跑一遍分层校验，
// 给出「哪一层挂了」的诊断，而不是只有一个笼统的「通 / 不通」。
//
// ## 与 cfpilot test（CLI）的关系
//
// CLI 的 single.ts 是面向命令行的完整诊断（还含 PONG / 隧道验证）；
// 这里只做**桌面版历史复测**需要的分层可用性校验，不重复 PONG / 隧道部分
// （那是「节点能不能真出网」，历史里已经选过的 IP 默认能出网，
//  复测关注的是「边缘入口还通不通」）。
// 两层探测原语（TCP/TLS/WS101）与 CLI 逐字段对齐，行为一致。

import (
	"context"
	"sync"
	"time"
)

// IPTestResult 是单 IP 复测结果。
type IPTestResult struct {
	IP    string  `json:"ip"`
	Port  int     `json:"port"`
	TCPMs int64   `json:"tcpMs"`
	TLSMs int64   `json:"tlsMs"`
	WSOK  bool    `json:"wsOk"`
	Colo  string  `json:"colo"`
	Speed float64 `json:"speed"` // 仅 withSpeed=true 时有意义
	// OK 表示三层（TCP + TLS + WS101）全部通过。
	OK bool `json:"ok"`
	// Error 是**第一道失败层**的原因（TCP 失败就不测后面了）。
	Error string `json:"error,omitempty"`
}

// TestOptions 是复测参数。
type TestOptions struct {
	Host      string
	WSPath    string
	ProbePath string
	WithSpeed bool
	// Concurrency 是并发复测的 IP 数（0 → 默认 16）。
	Concurrency int
	// PerIPTimeout 是单 IP 的**整体预算**（0 → 默认 8 秒）。
	PerIPTimeout time.Duration
}

// TestTarget 是待复测的单个 IP。
type TestTarget struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

// TestIP 对单个 IP 跑分层校验。
//
// 顺序：TCP → TLS → WS101 →（可选）测速。
// 任一层失败即停止，把失败原因写进 Error，OK=false。
func TestIP(ctx context.Context, t TestTarget, opt TestOptions) IPTestResult {
	res := IPTestResult{IP: t.IP, Port: t.Port}

	perIP := opt.PerIPTimeout
	if perIP <= 0 {
		perIP = 8 * time.Second
	}
	ipCtx, cancel := context.WithTimeout(ctx, perIP)
	defer cancel()

	// 阶段一：TCP 握手
	tcp := ProbeTCP(ipCtx, t.IP, t.Port, msDuration(int(perIP.Milliseconds())))
	if !tcp.OK {
		res.Error = tcp.Error
		return res
	}
	res.TCPMs = tcp.Latency

	// 阶段一之二：TLS 握手（用用户域名作 SNI）
	tls := ProbeTLS(ipCtx, t.IP, t.Port, opt.Host, 2000*time.Millisecond)
	if !tls.OK {
		res.Error = tls.Error
		return res
	}
	res.TLSMs = tls.TLSMs

	// 阶段二：WS 101 校验（拿到机房码，确认是可用数据面）
	ws := ProbeWS101(ipCtx, t.IP, t.Port, opt.Host, 3000*time.Millisecond, opt.WSPath)
	if !ws.OK {
		res.Error = ws.Error
		return res
	}
	res.WSOK = true
	res.Colo = ws.Colo
	res.OK = true

	if opt.WithSpeed {
		// 阶段三：真实下行测速（复用阶段三计量实现）。
		// 只在 101 通过后才测速 —— 与 Run 的约束一致，
		// 否则测的是「能返回数据的 HTTP 服务」而非可用节点。
		dl := MeasureThroughput(ipCtx, MeasureOptions{
			IP:          t.IP,
			Port:        t.Port,
			Host:        opt.Host,
			BytesWanted: defMeasureBytes,
			Timeout:     perIP,
			Path:        opt.ProbePath,
			Connections: defMeasureConnections,
			Duration:    4 * time.Second,
			Warmup:      defMeasureWarmupMs * time.Millisecond,
			Window:      defMeasureWindowMs * time.Millisecond,
			MinBytes:    defMeasureMinBytes,
		})
		if dl.OK {
			res.Speed = dl.SteadyMBps
		}
	}
	return res
}

// TestIPs 并发复测一批 IP，返回与输入等长的切片（顺序一致）。
//
// 并发上限受 Concurrency 约束，不会因为传入几千个 IP 就起几千个 goroutine。
func TestIPs(ctx context.Context, targets []TestTarget, opt TestOptions) []IPTestResult {
	out := make([]IPTestResult, len(targets))
	if len(targets) == 0 {
		return out
	}

	concurrency := opt.Concurrency
	if concurrency <= 0 {
		concurrency = 16
	}
	if concurrency > len(targets) {
		concurrency = len(targets)
	}

	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				if ctx.Err() != nil {
					out[idx] = IPTestResult{IP: targets[idx].IP, Port: targets[idx].Port, Error: "已取消"}
					continue
				}
				out[idx] = TestIP(ctx, targets[idx], opt)
			}
		}()
	}
	go func() {
		defer close(jobs)
		for i := range targets {
			select {
			case <-ctx.Done():
				return
			case jobs <- i:
			}
		}
	}()
	wg.Wait()
	return out
}
