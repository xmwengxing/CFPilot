package scan

import (
	"context"
	"testing"
	"time"
)

// 真机测试：采样 + TCP + TLS 全流程，找出「TLS 全部失败」的原因。
func TestLiveSampleAndTLS(t *testing.T) {
	host := getenvOrSkip(t, "CFPILOT_LIVE_HOST")

	// 采样 30 个
	ips := SampleCandidates(SampleOptions{Count: 30})
	t.Logf("采样 %d 个 IP", len(ips))

	okTCP := 0
	okTLS := 0
	for i, ip := range ips {
		if i >= 12 {
			break
		}
		tcp := ProbeTCP(context.Background(), ip, 443, 1500*time.Millisecond)
		if !tcp.OK {
			t.Logf("  %-16s TCP FAIL (%s)", ip, tcp.Error)
			continue
		}
		okTCP++
		tlsR := ProbeTLS(context.Background(), ip, 443, host, 4*time.Second)
		if tlsR.OK {
			okTLS++
			t.Logf("  %-16s TCP %3dms  TLS OK %4dms", ip, tcp.Latency, tlsR.TLSMs)
		} else {
			t.Logf("  %-16s TCP %3dms  TLS FAIL %s", ip, tcp.Latency, tlsR.Error)
		}
	}
	t.Logf("结果：TCP 通过 %d，TLS 通过 %d", okTCP, okTLS)
	if okTLS == 0 && okTCP > 0 {
		t.Error("TCP 通了但 TLS 全失败 —— 这就是用户遇到的现象")
	}
}
