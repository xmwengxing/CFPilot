package scan

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ------------------------------------------------------------------
// 进度节流
// ------------------------------------------------------------------

func TestProgressThrottleMatchesCLIRules(t *testing.T) {
	th := NewProgressThrottle()

	// 阶段一：6556 个候选 → 每 500 个报一次
	reported := 0
	for done := 1; done <= 6556; done++ {
		if th.ShouldReport(Progress{Stage: "tcp", Done: done, Total: 6556}) {
			reported++
		}
	}
	// 1（首）+ 13（500..6500）+ 1（末）= 15
	if reported > 20 {
		t.Errorf("阶段一报太多：%d 条（期望约 15）", reported)
	}
	if reported < 10 {
		t.Errorf("阶段一报太少：%d 条", reported)
	}
}

func TestProgressThrottleStageTwoIsPerItem(t *testing.T) {
	th := NewProgressThrottle()
	reported := 0
	for done := 1; done <= 30; done++ {
		if th.ShouldReport(Progress{Stage: "speed", Done: done, Total: 30}) {
			reported++
		}
	}
	// 30 个候选少，逐个报
	if reported < 25 {
		t.Errorf("测速阶段应逐项报告，实际 %d 条", reported)
	}
}

func TestProgressThrottleResetsOnStageChange(t *testing.T) {
	th := NewProgressThrottle()
	// 阶段一跑到 600
	th.ShouldReport(Progress{Stage: "tcp", Done: 1, Total: 6556})
	for done := 2; done <= 600; done++ {
		th.ShouldReport(Progress{Stage: "tcp", Done: done, Total: 6556})
	}
	// 换阶段 → 第一条必报（不能因为上一阶段的计数而漏报）
	if !th.ShouldReport(Progress{Stage: "tls", Done: 1, Total: 600}) {
		t.Error("换阶段后第一条必须报出")
	}
}

func TestProgressThrottleAlwaysReportsLast(t *testing.T) {
	th := NewProgressThrottle()
	th.ShouldReport(Progress{Stage: "tls", Done: 1, Total: 600})
	for done := 2; done < 600; done++ {
		th.ShouldReport(Progress{Stage: "tls", Done: done, Total: 600})
	}
	if !th.ShouldReport(Progress{Stage: "tls", Done: 600, Total: 600}) {
		t.Error("最后一个必须报出（否则看不到「结束了」）")
	}
}

// ------------------------------------------------------------------
// 整体预算（与 CLI 的 setTimeout(total) 对齐）
// ------------------------------------------------------------------

// TestMeasureDownloadHasTotalBudget 守护「测速不会无限挂住」。
//
// ## 背景（2026-10-28 真机故障）
//
// 原实现只有「每次读的超时」：对方持续 trickle 数据时，
// 每次读都能成功 → 读超时被无限推迟 → **整个测速永远不结束**。
//
// 真机表现：阶段三卡在 29/30 超过 8 分钟不动，
// 进程里挂着一个 ESTABLISHED 但没有数据流动的连接。
//
// 修法：加**整体预算**（与 CLI 版 measureThroughput 的
// `setTimeout(..., timeoutMs)` 同义），超时即判「测速超时」。
// 新口径下它是多连接 + 稳态计量，但「到点必返回」的约束不变。
func TestMeasureDownloadHasTotalBudget(t *testing.T) {
	// 假服务器（**真 TLS**）：回响应头后**极慢地 trickle** 数据，
	// 永远发不满 —— 这种行为下「只靠读超时」的旧实现会永远挂着。
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		// 带探针标记：让失败原因落在「载荷不足 / 超时」，
		// 而不是被响应头校验提前判死（那样测不到整体预算）。
		w.Header().Set("X-Probe-Bytes", "1048576")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		// 每 100ms 只写 1 字节，且**不结束响应**（连接一直开着）
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			if _, err := w.Write([]byte("x")); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}))
	defer srv.Close()

	host, portStr, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}

	// timeout = 2 秒。
	//
	// ⚠️ CLI 版的语义是「整体预算 == 空闲超时 == timeout」：
	//   - 整体定时器：到点必结束（无论对方是否还在 trickle）
	//   - 空闲超时：每次收到数据就重置
	//
	// 所以在这个场景里，**空闲超时永远不会触发**（数据一直在来），
	// 真正让测速结束的是**整体预算**。
	//
	// 没有整体预算的旧实现会一直挂到服务器关闭（30 秒）——
	// 这正是真机「卡在 29/30 超过 8 分钟」的成因。
	const budget = 2 * time.Second
	start := time.Now()
	res := MeasureDownload(context.Background(), host, port, "example.test",
		1024*1024, budget, "/__edge_probe")
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
