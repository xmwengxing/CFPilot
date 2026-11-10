package scan

import (
	"reflect"
	"testing"
)

// 下行速度下限（--min-speed）的淘汰逻辑。
//
// CLI 是权威实现（AGENTS.md §2.2），packages/cli/test/min-speed.test.ts
// 用同一组输入做对照 —— 两端必须给出相同的保留集合。
func TestFilterByMinSpeed(t *testing.T) {
	entries := []Entry{
		{IP: "104.16.0.1", Speed: 0.4},
		{IP: "104.16.0.2", Speed: 3.2},
		{IP: "104.16.0.3", Speed: 0.9},
		{IP: "104.16.0.4", Speed: 1.0},
	}

	// 下限 0：不过滤
	if got := filterByMinSpeed(entries, 0); len(got) != len(entries) {
		t.Fatalf("下限 0 时应原样返回，实际保留 %d 条", len(got))
	}
	// 负下限：视为不过滤
	if got := filterByMinSpeed(entries, -1); len(got) != len(entries) {
		t.Fatalf("负下限时应不过滤，实际保留 %d 条", len(got))
	}
	// 下限 1：保留 speed >= 1 的（1.0 恰好等于下限要保留）
	got := filterByMinSpeed(entries, 1)
	if len(got) != 2 {
		t.Fatalf("下限 1 时应保留 2 条，实际 %d", len(got))
	}
	if got[0].IP != "104.16.0.2" || got[1].IP != "104.16.0.4" {
		t.Fatalf("保留集合不符：%+v", got)
	}
	// 全部低于下限时返回空
	if got := filterByMinSpeed(entries, 99); len(got) != 0 {
		t.Fatalf("全部低于下限时应为空，实际 %d 条", len(got))
	}
}

// 峰值高但稳态低的候选必须被淘汰 —— 峰值是单窗口突发值，不能当门槛。
func TestFilterByMinSpeedIgnoresPeak(t *testing.T) {
	entries := []Entry{{IP: "104.16.0.1", Speed: 0.5, PeakSpeed: 12}}
	if got := filterByMinSpeed(entries, 1); len(got) != 0 {
		t.Fatalf("稳态 0.5 的候选不应因峰值高而保留")
	}
}

// 与 CLI 对照：同一组 speed 值，两端保留集合必须一致。
func TestFilterByMinSpeedMatchesCLIFixture(t *testing.T) {
	// CLI 侧 test/min-speed.test.ts 的输入
	rows := []float64{0.4, 3.2, 0.9}
	var entries []Entry
	for i, sp := range rows {
		entries = append(entries, Entry{IP: string(rune('a' + i)), Speed: sp})
	}
	got := filterByMinSpeed(entries, 1)
	if len(got) != 1 {
		t.Fatalf("下限 1 时应保留 1 条，实际 %d", len(got))
	}
	if got[0].Speed != 3.2 {
		t.Fatalf("保留的应是速度 3.2 的那条，实际 %v", got[0].Speed)
	}
}

// 过滤必须发生在「取前 N」之前 —— 否则会得到不足 Top 条的结果。
func TestFilterRunsBeforeTop(t *testing.T) {
	var entries []Entry
	for i := 0; i < 10; i++ {
		entries = append(entries, Entry{IP: string(rune('a' + i)), Speed: float64(i)})
	}
	filtered := filterByMinSpeed(entries, 5)
	picked := PickWithDiversity(filtered, 3)
	if len(picked) != 3 {
		t.Fatalf("过滤后仍应能取满 3 条，实际 %d", len(picked))
	}
	for _, e := range picked {
		if e.Speed < 5 {
			t.Fatalf("取出的条目速度低于下限：%+v", e)
		}
	}
}

// 跳过测速 + 速度下限必须报错，而不是静默返回空结果。
func TestMinSpeedRejectsSkipSpeed(t *testing.T) {
	opt := Options{
		Host:         "example.com",
		Candidates:   []string{"104.16.0.1"},
		SkipSpeed:    true,
		MinSpeedMBps: 1,
	}
	if _, err := Run(t.Context(), opt); err == nil {
		t.Fatal("跳过测速 + 速度下限应报错")
	}
}

// 用 reflect 兜住「过滤改变了原切片」这类副作用。
func TestFilterDoesNotMutateInput(t *testing.T) {
	entries := []Entry{
		{IP: "104.16.0.1", Speed: 0.1},
		{IP: "104.16.0.2", Speed: 5},
	}
	before := append([]Entry(nil), entries...)
	filterByMinSpeed(entries, 1)
	if !reflect.DeepEqual(before, entries) {
		t.Fatalf("过滤不应改动入参：%+v", entries)
	}
}
