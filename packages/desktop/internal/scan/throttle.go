package scan

import (
	"sync"
	"time"
)

// 进度节流的「每多少个报一次」。
//
// ⚠️ 必须与 CLI 版 packages/cli/src/scan/scan.ts **逐项对齐**
// （AGENTS.md §2.2：CLI 是优选扫描的权威实现）。
// CLI 侧的规则是：
//
//	done % 500 === 0 || done === candidates.length      ← 阶段一 TCP
//	tlsDone % 200 === 0 || tlsDone === tlsInput.length  ← 阶段一之二 TLS
//	（阶段二 / 阶段三逐个报 —— 候选数本来就少：≤120 / ≤30）
const (
	progressStepTCP = 500
	progressStepTLS = 200
)

// ProgressThrottle 把「逐候选」的进度回调节流成**可读**的日志。
//
// # 为什么需要
//
// 扫描的三个阶段都是**逐候选**回调进度的。Go 版原先一个候选一条日志，
// 默认采样 6556 时单次扫描产生 **15349 条 / 1 MB**（真机实测），
// 把运行日志窗口完全冲垮 —— 阶段切换、结果、错误这些关键信息全被淹没。
//
// 节流后单次扫描约 **170 条**（与 CLI 版一致）。
type ProgressThrottle struct {
	mu sync.Mutex

	// lastDone 是上次报出去的序号
	lastDone int
	// lastAt 是上次报出去的时刻
	lastAt time.Time
	// step 是当前阶段的步长
	step int
	// stage 是当前阶段（换阶段时重置计数）
	stage string
	// started 标记是否已经报过第一条
	started bool
}

// NewProgressThrottle 造一个节流器。
func NewProgressThrottle() *ProgressThrottle {
	return &ProgressThrottle{}
}

// ShouldReport 判断这条进度是否值得报出去。
//
// 返回 true 时调用方应当输出一条日志。
func (t *ProgressThrottle) ShouldReport(p Progress) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	now := time.Now()

	// 换阶段 → 重置（步长也换）
	if p.Stage != t.stage {
		t.stage = p.Stage
		t.lastDone = 0
		t.started = false
		t.step = progressStepFor(p.Stage)
	}

	// 第一条：必报（用户能看到「开始了」）
	if !t.started {
		t.started = true
		t.lastDone = p.Done
		t.lastAt = now
		return true
	}

	// 最后一条：必报（用户能看到「结束了」）
	if p.Total > 0 && p.Done >= p.Total {
		t.lastDone = p.Done
		t.lastAt = now
		return true
	}

	// 每 step 个报一次（与 CLI 一致）
	if p.Done-t.lastDone >= t.step {
		t.lastDone = p.Done
		t.lastAt = now
		return true
	}

	// 慢阶段兜底：距上次超过 5 秒也报一次。
	//
	// 目的：慢阶段（测速）如果真的卡住，用户至少能看到「还在动 / 停在哪」，
	// 而不是以为程序死了。
	if now.Sub(t.lastAt) >= 5*time.Second {
		t.lastDone = p.Done
		t.lastAt = now
		return true
	}

	return false
}

// progressStepFor 算某个阶段的步长。
func progressStepFor(stage string) int {
	switch stage {
	case "tcp":
		return progressStepTCP
	case "tls":
		return progressStepTLS
	default:
		// 阶段二（WS ≤120）与阶段三（测速 ≤30）候选数少，逐个报
		return 1
	}
}
