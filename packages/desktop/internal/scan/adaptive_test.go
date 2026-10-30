package scan

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// TestAdaptiveConcurrencyNeverExceedsLimit 验证自适应降并发不会突破用户设置的上限。
//
// 回归点：早前降并发的下限写死 8，用户设 2 / 4 / 6 时反而会被抬到 8 ——
// 与「限制并发」的意图完全相反，且与 CLI 版行为不一致。
func TestAdaptiveConcurrencyNeverExceedsLimit(t *testing.T) {
	for _, limit := range []int{1, 2, 4, 6} {
		limit := limit
		var active int32
		var peak int32

		items := make([]int, 40)
		for i := range items {
			items[i] = i
		}

		out := forEachIPAdaptive(context.Background(), items, limit, func(int) (TCPResult, bool) {
			cur := atomic.AddInt32(&active, 1)
			for {
				old := atomic.LoadInt32(&peak)
				if cur <= old || atomic.CompareAndSwapInt32(&peak, old, cur) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			atomic.AddInt32(&active, -1)
			// 第二个返回值 = 「保留这条结果」；结果本身是失败（OK=false），
			// 于是整批成功率 0% → 触发降并发分支。
			return TCPResult{OK: false}, true
		}, nil, 10)

		if len(out) != len(items) {
			t.Fatalf("并发上限 %d：结果数 %d，期望 %d", limit, len(out), len(items))
		}
		if got := int(atomic.LoadInt32(&peak)); got > limit {
			t.Fatalf("并发上限 %d 时观察到的峰值为 %d —— 自适应不得突破用户设置", limit, got)
		}
	}
}
