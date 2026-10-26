package scan

import (
	"context"
	"testing"
	"time"
)

// 用默认参数跑完整扫描（复现用户的实际场景）。
func TestLiveFullScanDefaults(t *testing.T) {
	host := getenvOrSkip(t, "CFPILOT_LIVE_HOST")

	start := time.Now()
	sum, err := Run(context.Background(), Options{
		Host:       host,
		Candidates: SampleCandidates(SampleOptions{Count: 500}), // 先用 500 避免太慢
		Progress: func(p Progress) {
			if p.Done == p.Total || p.Done%200 == 0 {
				t.Logf("[%s] %d/%d %s", p.Stage, p.Done, p.Total, p.Message)
			}
		},
	})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("耗时 %v", elapsed.Round(time.Second))
	t.Logf("stats: %+v", sum.Stats)
	t.Logf("结果: %d 个可用节点", len(sum.Entries))
	for i, e := range sum.Entries {
		if i >= 3 {
			break
		}
		t.Logf("  %s:%d #%s TLS=%dms speed=%.2fMB/s", e.IP, e.Port, e.Colo, e.TLSMs, e.Speed)
	}
}
