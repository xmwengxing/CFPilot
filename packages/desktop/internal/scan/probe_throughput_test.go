package scan

// 阶段三测速口径的回归测试（对照 CLI 的 true-probe / window-meter 测试）。
//
// ## 这个文件在防什么
//
//  1. **慢启动被当成链路能力**：旧口径「总字节 ÷ 从拨号起算的总耗时」
//     把真机同一链路的 0.87 MB/s 报成 0.42 MB/s；
//  2. **单连接填不满链路**：真机同一链路单流稳态 0.47 MB/s、3 流 1.14 MB/s；
//  3. **Pages 欢迎页假阳性**：目标没有探针端点时回 200 + HTML，
//     缺 x-probe-bytes 校验就会产出「速度极低但 OK」的节点；
//  4. **测速挂死**：trickle 数据让读超时永远不触发（上一轮真机踩过）。
//
// 全部用本地 httptest TLS 服务器，不依赖外网 / Windows 路径，CI 可直接跑。

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// splitTLSAddr 从 httptest 的 https:// URL 里取出 IP / 端口。
func splitTLSAddr(t *testing.T, srv *httptest.Server) (string, int) {
	t.Helper()
	host, portStr, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	return host, port
}

// setProbeHeaders 写测速响应头。
//
// ⚠️ x-probe-bytes 是探针端点的独有标记，新口径下**必填**。
func setProbeHeaders(w http.ResponseWriter, probeBytes int) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Probe-Bytes", strconv.Itoa(probeBytes))
}

// (a) 慢启动 + 稳态：稳态必须明显高于「含慢启动的整段平均」，
// 且接近后者段的真实速率。
func TestMeasureThroughputSteadyBeatsAvg(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setProbeHeaders(w, 100*1024*1024)
		w.WriteHeader(http.StatusOK)
		flusher, hasFlusher := w.(http.Flusher)
		if hasFlusher {
			flusher.Flush()
		}

		// 前 1s：每 100ms 20KB（≈0.2 MB/s，模拟 TCP 慢启动）；
		// 之后：每 50ms 128KB（≈2.5 MB/s，稳态）。
		start := time.Now()
		buf := make([]byte, 128*1024)
		for {
			chunk, wait := 20*1024, 100*time.Millisecond
			if time.Since(start) >= time.Second {
				chunk, wait = 128*1024, 50*time.Millisecond
			}
			if _, err := w.Write(buf[:chunk]); err != nil {
				return
			}
			if hasFlusher {
				flusher.Flush()
			}
			// 兜底：客户端异常不关连接时，别让 handler 永久跑下去。
			if time.Since(start) > 5*time.Second {
				return
			}
			select {
			case <-r.Context().Done():
				return
			case <-time.After(wait):
			}
		}
	}))
	defer srv.Close()

	host, port := splitTLSAddr(t, srv)
	res := MeasureThroughput(context.Background(), MeasureOptions{
		IP:          host,
		Port:        port,
		Host:        "test.example.com",
		BytesWanted: 100 * 1024 * 1024,
		Timeout:     8 * time.Second,
		Path:        "/__edge_probe",
		// 单连接 → 聚合带宽就是单流速率，才能和「后者段 2.5 MB/s」直接比。
		Connections: 1,
		Duration:    2500 * time.Millisecond,
		Warmup:      1000 * time.Millisecond,
		Window:      400 * time.Millisecond,
	})

	if !res.OK {
		t.Fatalf("测速应成功，实际 error=%q bytes=%d", res.Error, res.Bytes)
	}
	// 诊断用（只在 -v 下显示）：稳态 / 整段平均 / 峰值的实际数值。
	t.Logf("单连接慢启动+稳态：steady=%.2f avg=%.2f peak=%.2f bytes=%d ms=%d",
		res.SteadyMBps, res.AvgMBps, res.PeakMBps, res.Bytes, res.MS)
	if res.Connections != 1 {
		t.Errorf("应使用 1 条连接，实际 %d", res.Connections)
	}
	if res.Bytes < 1024*1024 {
		t.Fatalf("测试前提不成立：只收到 %d 字节，慢启动/稳态曲线没跑起来", res.Bytes)
	}

	// 稳态（丢预热后）必须明显高于含慢启动的整段平均。
	if res.AvgMBps <= 0 {
		t.Fatalf("整段平均应大于 0，实际 %f", res.AvgMBps)
	}
	if res.SteadyMBps <= res.AvgMBps*1.15 {
		t.Errorf("稳态应明显高于含慢启动的整段平均：steady=%.2f avg=%.2f",
			res.SteadyMBps, res.AvgMBps)
	}
	// 接近后者段 ≈2.5 MB/s（宽松区间，CI 调度抖动也不误报）。
	if res.SteadyMBps < 1.5 || res.SteadyMBps > 4.0 {
		t.Errorf("稳态应接近后者段的 ≈2.5 MB/s，实际 %.2f", res.SteadyMBps)
	}
	// 峰值是单窗口最大值，只作诊断，按定义不低于稳态。
	if res.PeakMBps+0.01 < res.SteadyMBps {
		t.Errorf("窗口峰值不应低于稳态：peak=%.2f steady=%.2f", res.PeakMBps, res.SteadyMBps)
	}
}

// (b) 多连接：服务端观察到的并发连接峰值必须 ≥2（默认 3 条）。
func TestMeasureThroughputUsesMultipleConnections(t *testing.T) {
	var mu sync.Mutex
	inFlight, peak := 0, 0

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		inFlight++
		if inFlight > peak {
			peak = inFlight
		}
		mu.Unlock()
		defer func() {
			mu.Lock()
			inFlight--
			mu.Unlock()
		}()

		setProbeHeaders(w, 100*1024*1024)
		w.WriteHeader(http.StatusOK)
		flusher, hasFlusher := w.(http.Flusher)
		if hasFlusher {
			flusher.Flush()
		}

		// 持续发小包，保证多条连接在测速窗口内**重叠**。
		buf := make([]byte, 4*1024)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if _, err := w.Write(buf); err != nil {
					return
				}
				if hasFlusher {
					flusher.Flush()
				}
			}
		}
	}))
	defer srv.Close()

	host, port := splitTLSAddr(t, srv)
	res := MeasureThroughput(context.Background(), MeasureOptions{
		IP:          host,
		Port:        port,
		Host:        "test.example.com",
		BytesWanted: 100 * 1024 * 1024,
		Timeout:     6 * time.Second,
		Path:        "/__edge_probe",
		Connections: 3,
		Duration:    1500 * time.Millisecond,
	})

	if !res.OK {
		t.Fatalf("测速应成功，实际 error=%q bytes=%d", res.Error, res.Bytes)
	}
	if res.Connections < 2 {
		t.Errorf("应至少建立 2 条连接，实际 %d", res.Connections)
	}

	mu.Lock()
	gotPeak := peak
	mu.Unlock()
	t.Logf("多连接：客户端成功握手 %d 条，服务端并发峰值 %d，bytes=%d",
		res.Connections, gotPeak, res.Bytes)
	// 默认 3 条，但 CI 调度可能让第 3 条慢一点；判 ≥2 即可证明「不是单流」。
	if gotPeak < 2 {
		t.Fatalf("服务端应同时处理 ≥2 条连接，实际峰值 %d", gotPeak)
	}
}

// (c) 响应头校验：只有 200 + HTML、没有 x-probe-bytes → 必须失败，
// 且错误信息里要能看到「探针」字样（可读、能指导排查）。
func TestMeasureThroughputRejectsMissingProbeHeader(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!doctype html><title>Welcome to Cloudflare Pages</title>"))
	}))
	defer srv.Close()

	host, port := splitTLSAddr(t, srv)
	res := MeasureThroughput(context.Background(), MeasureOptions{
		IP:          host,
		Port:        port,
		Host:        "test.example.com",
		BytesWanted: 1024 * 1024,
		Timeout:     6 * time.Second,
		Path:        "/__edge_probe",
		Connections: 1,
		Duration:    5 * time.Second,
	})

	if res.OK {
		t.Fatal("缺少 x-probe-bytes 的 200 欢迎页不能判成功（假阳性节点）")
	}
	if !strings.Contains(res.Error, "探针") {
		t.Errorf("错误信息应可读且提到探针端点，实际 %q", res.Error)
	}
	// 响应头不匹配要**立即**判失败，不必等测量时长跑完。
	if res.MS >= 3000 {
		t.Errorf("响应头不匹配应立即返回，实际耗时 %dms", res.MS)
	}
}

// (d) 整体预算：服务端每 100ms 只发 1 字节且永不停 → 必须在预算附近返回。
func TestMeasureThroughputHonorsTotalBudget(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setProbeHeaders(w, 1024*1024)
		w.WriteHeader(http.StatusOK)
		flusher, hasFlusher := w.(http.Flusher)
		if hasFlusher {
			flusher.Flush()
		}
		// 每 100ms 只写 1 字节，且**不结束响应**（连接一直开着）。
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			if _, err := w.Write([]byte("x")); err != nil {
				return
			}
			if hasFlusher {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	host, port := splitTLSAddr(t, srv)
	const budget = 2 * time.Second
	start := time.Now()
	res := MeasureThroughput(context.Background(), MeasureOptions{
		IP:          host,
		Port:        port,
		Host:        "test.example.com",
		BytesWanted: 1024 * 1024,
		Timeout:     budget,
		Path:        "/__edge_probe",
		Connections: 1,
		// Duration 故意远大于预算：真正让它结束的必须是**整体预算**。
		Duration: 30 * time.Second,
	})
	elapsed := time.Since(start)

	if elapsed > budget+2*time.Second {
		t.Errorf("整体预算失效：耗时 %v（预算 %v）—— 测速会一直挂着", elapsed, budget)
	}
	if elapsed < budget/2 {
		t.Errorf("测试前提不成立：%d 毫秒就结束了，说明没走到 trickle 路径", elapsed.Milliseconds())
	}
	if res.OK {
		t.Error("trickle 数据未达最小载荷时不应判成功")
	}
	if res.Error == "" {
		t.Error("应给出失败原因（超时）")
	}
}

// windowMeter 的纯逻辑测试：钉住「稳态 / 峰值 / 快速链路兜底」三个口径。
//
// 曲线取自真机（3 条并行连接、400ms 窗口）的逐窗速率，
// 与 CLI 的 window-meter.test.ts 用同一组数据。
func TestWindowMeterSemantics(t *testing.T) {
	start := time.Unix(0, 0)
	m := newWindowMeter(start, time.Second, 400*time.Millisecond)
	realCurve := []float64{0.38, 0.42, 0.91, 0.43, 1.05, 1.63, 1.04, 1.05, 1.49, 1.40, 1.11, 2.46, 0.66}
	now := start
	for _, mbps := range realCurve {
		m.add(int64(mbps * 1024 * 1024 * 0.4))
		now = now.Add(400 * time.Millisecond)
		m.tick(now)
	}
	_, steady, peak := m.finish(now)

	// 真机同一条链路：稳态 1.14、峰值 2.46 —— 对外报稳态。
	if steady < 0.9 || steady > 1.5 {
		t.Errorf("稳态应接近 1.14 MB/s，实际 %.2f", steady)
	}
	if peak < 2.3 {
		t.Errorf("峰值应被最后一个突发顶到 2.4 以上，实际 %.2f", peak)
	}
	if steady >= peak {
		t.Errorf("稳态不应被单个突发窗口拉高：steady=%.2f peak=%.2f", steady, peak)
	}

	// 快速链路在预热期内就传完：用整段速率兜底，不能是 0。
	fast := newWindowMeter(start, time.Second, 400*time.Millisecond)
	fast.add(15 * 1024 * 1024)
	_, fastSteady, fastPeak := fast.finish(start.Add(300 * time.Millisecond))
	if fastPeak < 40 || fastPeak > 60 {
		t.Errorf("15MB / 300ms ≈ 50 MB/s，实际峰值 %.2f", fastPeak)
	}
	if fastSteady != fastPeak {
		t.Errorf("预热期内传完时稳态应退回峰值，实际 steady=%.2f peak=%.2f", fastSteady, fastPeak)
	}

	// 一个字节都没收到：不能被兜底逻辑编出数字。
	empty := newWindowMeter(start, time.Second, 400*time.Millisecond)
	total, emptySteady, emptyPeak := empty.finish(start.Add(2 * time.Second))
	if total != 0 || emptySteady != 0 || emptyPeak != 0 {
		t.Errorf("无数据时应全为 0，实际 total=%d steady=%.2f peak=%.2f", total, emptySteady, emptyPeak)
	}
}
