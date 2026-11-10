package schedule

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// 测试用的固定时间基准。
//
// ⚠️ 必须用**固定时区**测：夏令时相关的边界只有在特定时区才复现。
// 本文件用 Asia/Shanghai（无夏令时）与 America/New_York（有夏令时）各测一遍。
func fixedLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		// 容器里可能没有 tzdata；退化成 UTC 也能测大部分逻辑。
		return time.UTC
	}
	return loc
}

func TestDayNumberRoundTrip(t *testing.T) {
	cases := []struct {
		y int
		m time.Month
		d int
	}{
		{1970, time.January, 1},
		{2000, time.March, 1},
		{2026, time.November, 10},
		{2026, time.December, 31},
		{2024, time.February, 29},
	}
	for _, c := range cases {
		got := dayNumber(c.y, c.m, c.d)
		back := dateFromDayNumber(got)
		if back.Year() != c.y || back.Month() != c.m || back.Day() != c.d {
			t.Fatalf("dayNumber(%d-%d-%d)=%d 回推为 %v", c.y, c.m, c.d, got, back)
		}
	}
}

// 民用日序号必须与真实日历一致 —— 跨月跨年是周期计算的成败关键。
//
// 基准日 1970-01-01 的日序是 0。
func TestDayNumberCalendarAlignment(t *testing.T) {
	loc := fixedLoc(t, "Asia/Shanghai")
	base := time.Date(2026, time.November, 1, 12, 0, 0, 0, loc)
	prev := dayNumber(base.Year(), base.Month(), base.Day())
	// 从 11-01 往后逐日推，日序必须每天 +1，跨月跨年都不能跳。
	for i := 1; i <= 120; i++ {
		d := base.AddDate(0, 0, i)
		got := dayNumber(d.Year(), d.Month(), d.Day())
		if got != prev+i {
			t.Fatalf("%v 的日序应为 %d，实际 %d", d.Format("2006-01-02"), prev+i, got)
		}
	}
	// 已知基准：2026-11-01 距 1970-01-01 有 20758 天
	if prev != 20758 {
		t.Fatalf("2026-11-01 的日序应为 20758，实际 %d", prev)
	}
}

func TestLastOccurrenceAlignsToAnchor(t *testing.T) {
	loc := fixedLoc(t, "Asia/Shanghai")
	anchor := time.Date(2026, time.November, 10, 10, 0, 0, 0, loc)
	task := Task{
		IntervalDays: 2,
		RunAt:        "09:00",
		AnchorAt:     anchor.UnixMilli(),
	}
	// 11-12 09:00 之后的任一时刻，最近一次运行都应是 11-12 09:00
	now := time.Date(2026, time.November, 12, 9, 30, 0, 0, loc)
	got := task.LastOccurrence(now)
	want := time.Date(2026, time.November, 12, 9, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("最近一次运行应为 %v，实际 %v", want, got)
	}
	// 11-13（与 11-12 不同余）时，最近一次应仍是 11-12
	now = time.Date(2026, time.November, 13, 8, 0, 0, 0, loc)
	got = task.LastOccurrence(now)
	if !got.Equal(want) {
		t.Fatalf("11-13 的最近一次运行应为 %v，实际 %v", want, got)
	}
}

func TestNextOccurrenceSkipsToNextAlignedDay(t *testing.T) {
	loc := fixedLoc(t, "Asia/Shanghai")
	anchor := time.Date(2026, time.November, 10, 10, 0, 0, 0, loc)
	task := Task{
		IntervalDays: 2,
		RunAt:        "09:00",
		AnchorAt:     anchor.UnixMilli(),
	}
	// 创建当天 09:00 已过（锚点 10:00）⇒ 首跑落在下一个同余日 11-12
	now := anchor
	got := task.NextOccurrence(now)
	want := time.Date(2026, time.November, 12, 9, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("首跑应为 %v，实际 %v", want, got)
	}
}

// 夏令时切换那天不能偏一天。
//
// 2026-03-08 是 America/New_York 的「春季前跳」日：那天只有 23 小时。
// 用「时刻差 / 24h」算日差会在这里出错，用民用日序号不会。
func TestDayNumberSurvivesDST(t *testing.T) {
	loc := fixedLoc(t, "America/New_York")
	base := time.Date(2026, time.March, 6, 12, 0, 0, 0, loc)
	prev := dayNumber(base.Year(), base.Month(), base.Day())
	for i := 1; i <= 6; i++ {
		d := base.AddDate(0, 0, i)
		got := dayNumber(d.Year(), d.Month(), d.Day())
		if got != prev+i {
			t.Fatalf("DST 附近 %v 的日序应为 %d，实际 %d", d.Format("2006-01-02"), prev+i, got)
		}
	}
	// 跨 DST 的周期对齐：锚点 03-06，每 2 天 ⇒ 03-06 / 03-08 / 03-10
	anchor := base
	task := Task{
		IntervalDays: 2,
		RunAt:        "09:00",
		AnchorAt:     anchor.UnixMilli(),
	}
	now := time.Date(2026, time.March, 10, 12, 0, 0, 0, loc)
	got := task.LastOccurrence(now)
	want := time.Date(2026, time.March, 10, 9, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("跨 DST 的最近一次运行应为 %v，实际 %v", want, got)
	}
}

func TestParseRunAt(t *testing.T) {
	cases := []struct {
		in      string
		hh      int
		mm      int
		wantErr bool
	}{
		{"00:00", 0, 0, false},
		{"09:30", 9, 30, false},
		{"23:59", 23, 59, false},
		{"24:00", 0, 0, true},
		{"12:60", 0, 0, true},
		{"9:30", 0, 0, true},
		{"0930", 0, 0, true},
		{"", 0, 0, true},
	}
	for _, c := range cases {
		hh, mm, err := parseRunAt(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("%q 应报错", c.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%q 不应报错：%v", c.in, err)
		}
		if hh != c.hh || mm != c.mm {
			t.Fatalf("%q 解析为 %d:%d，期望 %d:%d", c.in, hh, mm, c.hh, c.mm)
		}
	}
}

// 环上距离：跨零点也必须判为冲突。
func TestRingDistance(t *testing.T) {
	cases := []struct {
		a, b int
		want int
	}{
		{0, 0, 0},
		{60, 90, 30},
		{60, 89, 29},
		{1430, 10, 20},  // 23:50 与 00:10
		{10, 1430, 20},  // 反向
		{0, 720, 720},   // 正午对午夜
		{60, 1380, 120}, // 01:00 与 23:00 —— 时钟上相隔 2 小时
	}
	for _, c := range cases {
		if got := ringDistance(c.a, c.b); got != c.want {
			t.Fatalf("ringDistance(%d,%d)=%d，期望 %d", c.a, c.b, got, c.want)
		}
	}
}

func TestHasConflict(t *testing.T) {
	cases := []struct {
		name      string
		candidate string
		other     string
		enabled   bool
		want      bool
	}{
		{"完全相同", "01:00", "01:00", true, true},
		{"相差 29 分钟", "01:00", "01:29", true, true},
		{"相差 30 分钟（不冲突）", "01:00", "01:30", true, false},
		{"跨零点 20 分钟", "23:50", "00:10", true, true},
		{"跨零点 20 分钟（反向）", "00:10", "23:50", true, true},
		{"跨零点 70 分钟（不冲突）", "01:00", "23:50", true, false},
		{"禁用任务不参与判定", "01:00", "01:10", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			other := Task{ID: "task_other", Enabled: c.enabled, RunAt: c.other}
			candidate := Task{ID: "task_a", Enabled: true, RunAt: c.candidate}
			_, got := HasConflict([]Task{other}, candidate)
			if got != c.want {
				t.Fatalf("期望冲突=%v，实际 %v", c.want, got)
			}
		})
	}
}

// 冲突判定必须跨账号 —— 扫描互斥锁是进程级的，跨账号也会撞车。
func TestHasConflictAcrossProfiles(t *testing.T) {
	other := Task{ID: "task_b", Enabled: true, RunAt: "01:10", ProfileID: "acc_other"}
	candidate := Task{ID: "task_a", Enabled: true, RunAt: "01:00", ProfileID: "acc_main"}
	hit, ok := HasConflict([]Task{other}, candidate)
	if !ok {
		t.Fatal("跨账号的时刻冲突应被识别")
	}
	if hit.ID != "task_b" {
		t.Fatalf("应报出冲突任务 task_b，实际 %s", hit.ID)
	}
}

// 自身不与自己冲突（编辑时改自己的时刻）。
func TestHasConflictIgnoresSelf(t *testing.T) {
	task := Task{ID: "task_a", Enabled: true, RunAt: "01:00"}
	if _, ok := HasConflict([]Task{task}, task); ok {
		t.Fatal("任务不应与自己冲突")
	}
}

// 禁用的候选不参与判定（它不会跑）——
// 用户可以先调好参数、之后再启用。
func TestHasConflictIgnoresDisabledCandidate(t *testing.T) {
	other := Task{ID: "task_b", Enabled: true, RunAt: "01:00"}
	disabled := Task{ID: "task_a", Enabled: false, RunAt: "01:00"}
	if _, ok := HasConflict([]Task{other}, disabled); ok {
		t.Fatal("禁用的候选不应被判为冲突")
	}
}

func TestIsDueWindow(t *testing.T) {
	loc := fixedLoc(t, "Asia/Shanghai")
	anchor := time.Date(2026, time.November, 10, 0, 0, 0, 0, loc)
	task := Task{
		ID:           "task_a",
		Enabled:      true,
		IntervalDays: 2,
		RunAt:        "09:00",
		AnchorAt:     anchor.UnixMilli(),
	}
	occ := time.Date(2026, time.November, 10, 9, 0, 0, 0, loc)

	if !task.IsDue(occ) {
		t.Fatal("运行时刻本身应处于触发窗口内")
	}
	if !task.IsDue(occ.Add(29 * time.Minute)) {
		t.Fatal("窗口内（29 分钟）应仍可触发")
	}
	if task.IsDue(occ.Add(30 * time.Minute)) {
		t.Fatal("窗口外（30 分钟）不应再触发")
	}
	if task.IsDue(occ.Add(-time.Minute)) {
		t.Fatal("运行时刻之前不应触发")
	}
	// 禁用任务不触发
	disabled := task
	disabled.Enabled = false
	if disabled.IsDue(occ) {
		t.Fatal("禁用的任务不应触发")
	}
}

func TestHasRun(t *testing.T) {
	loc := fixedLoc(t, "Asia/Shanghai")
	anchor := time.Date(2026, time.November, 10, 0, 0, 0, 0, loc)
	occ := time.Date(2026, time.November, 10, 9, 0, 0, 0, loc)
	task := Task{
		ID:           "task_a",
		Enabled:      true,
		IntervalDays: 2,
		RunAt:        "09:00",
		AnchorAt:     anchor.UnixMilli(),
	}
	if task.HasRun(occ.Add(time.Minute)) {
		t.Fatal("没跑过时不应判为已跑")
	}
	task.LastRunAt = occ.UnixMilli()
	if !task.HasRun(occ.Add(time.Minute)) {
		t.Fatal("跑过本轮后应判为已跑")
	}
	// 下一轮（+2 天）不应被上一轮的 LastRunAt 误判
	next := time.Date(2026, time.November, 12, 9, 0, 0, 0, loc)
	if task.HasRun(next.Add(time.Minute)) {
		t.Fatal("上一轮的运行时刻不应让下一轮被判为已跑")
	}
}

func TestValidate(t *testing.T) {
	ok := Task{
		Name:         "每日优选",
		ProfileID:    "acc_1",
		IntervalDays: 2,
		RunAt:        "01:00",
		Scan:         ScanParams{SpeedMode: "two"},
	}
	if msg := ok.Validate(); msg != "" {
		t.Fatalf("合法任务不应报错：%s", msg)
	}

	cases := []struct {
		name string
		task Task
	}{
		{"空名称", Task{ProfileID: "acc_1", IntervalDays: 2, RunAt: "01:00"}},
		{"周期过小", Task{Name: "x", ProfileID: "acc_1", IntervalDays: 1, RunAt: "01:00"}},
		{"时间格式错", Task{Name: "x", ProfileID: "acc_1", IntervalDays: 2, RunAt: "25:00"}},
		{"负速度下限", Task{Name: "x", ProfileID: "acc_1", IntervalDays: 2, RunAt: "01:00", MinSpeedMBps: -1}},
		{"无归属账号", Task{Name: "x", IntervalDays: 2, RunAt: "01:00"}},
		{"跳过测速 + 速度下限", Task{Name: "x", ProfileID: "acc_1", IntervalDays: 2, RunAt: "01:00", MinSpeedMBps: 1, Scan: ScanParams{SpeedMode: "off"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if msg := c.task.Validate(); msg == "" {
				t.Fatalf("%s 应报错", c.name)
			}
		})
	}
}

// 内置任务：5 条、默认禁用、时间错开、按账号隔离。
func TestBuiltinTasks(t *testing.T) {
	now := time.Date(2026, time.November, 10, 12, 0, 0, 0, time.UTC)
	got := BuiltinTasks(nil, "acc_1", now)
	if len(got) != 5 {
		t.Fatalf("应有 5 条内置任务，实际 %d", len(got))
	}
	times := map[string]bool{}
	for _, task := range got {
		if !task.Builtin || task.BuiltinKey == "" {
			t.Fatalf("内置任务缺少身份标记：%+v", task)
		}
		if task.Enabled {
			t.Fatalf("内置任务 %s 默认应为禁用", task.Name)
		}
		if task.IntervalDays != BuiltinIntervalDays {
			t.Fatalf("内置任务 %s 的周期应为 %d，实际 %d", task.Name, BuiltinIntervalDays, task.IntervalDays)
		}
		if task.ProfileID != "acc_1" {
			t.Fatalf("内置任务归属账号应为 acc_1，实际 %s", task.ProfileID)
		}
		if task.Scan.Sample != BuiltinSample {
			t.Fatalf("内置任务 %s 的采样数应为 %d，实际 %d", task.Name, BuiltinSample, task.Scan.Sample)
		}
		if times[task.RunAt] {
			t.Fatalf("内置任务的运行时刻重复：%s", task.RunAt)
		}
		times[task.RunAt] = true
	}
	// 5 个内置任务互相不冲突（时刻错开 ≥ 30 分钟）
	for i, a := range got {
		for j, b := range got {
			if i == j {
				continue
			}
			hit, ok := HasConflict(got, withRunAt(a, b.RunAt))
			if ok && hit.ID != b.ID {
				t.Fatalf("内置任务 %s 与 %s 时刻冲突", a.Name, b.Name)
			}
		}
	}
}

// withRunAt 复制一份任务并改运行时刻（测试辅助）。
func withRunAt(t Task, runAt string) Task {
	t.RunAt = runAt
	return t
}

// 已有内置任务时不再重复生成；换个账号则重新生成一套。
func TestBuiltinTasksIdempotentPerProfile(t *testing.T) {
	now := time.Date(2026, time.November, 10, 12, 0, 0, 0, time.UTC)
	first := BuiltinTasks(nil, "acc_1", now)
	again := BuiltinTasks(first, "acc_1", now)
	if len(again) != 0 {
		t.Fatalf("同一账号不应重复生成，实际多了 %d 条", len(again))
	}
	other := BuiltinTasks(first, "acc_2", now)
	if len(other) != 5 {
		t.Fatalf("换个账号应重新生成 5 条，实际 %d", len(other))
	}
	for _, o := range other {
		if o.ProfileID != "acc_2" {
			t.Fatalf("新账号的内置任务归属错误：%s", o.ProfileID)
		}
	}
}

// 持久化往返。
func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st := New(dir)
	tasks := []Task{{
		ID:           "task_1",
		Name:         "任务一",
		Description:  "说明",
		ProfileID:    "acc_1",
		Enabled:      true,
		IntervalDays: 3,
		RunAt:        "02:30",
		MinSpeedMBps: 1.5,
		Scan:         ScanParams{Family: "v4", Countries: []string{"ASIA"}, Sample: 1500, Top: 8, SpeedMode: "two"},
		AnchorAt:     1700000000000,
		CreatedAt:    1700000000000,
		UpdatedAt:    1700000000000,
	}}
	if err := st.SaveTasks(tasks); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	// 新实例从磁盘读回
	st2 := New(dir)
	got := st2.Tasks()
	if len(got) != 1 {
		t.Fatalf("应读回 1 条，实际 %d", len(got))
	}
	if got[0].Name != "任务一" || got[0].MinSpeedMBps != 1.5 || got[0].IntervalDays != 3 {
		t.Fatalf("读回内容不符：%+v", got[0])
	}
	if len(got[0].Scan.Countries) != 1 || got[0].Scan.Countries[0] != "ASIA" {
		t.Fatalf("国家筛选读回不符：%+v", got[0].Scan)
	}
	// 文件权限应为 0600（不含密钥，但保持一致习惯）
	//
	// ⚠️ Windows 没有 Unix 权限位，os.WriteFile 的 mode 参数不生效，
	// 所以只在非 Windows 上校验。
	if runtime.GOOS != "windows" {
		info, err := os.Stat(st.TasksPath())
		if err != nil {
			t.Fatalf("读取文件信息失败：%v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("文件权限应为 0600，实际 %o", perm)
		}
	}
	// JSON 排版：2 空格缩进 + 结尾换行
	raw, err := os.ReadFile(st.TasksPath())
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 || raw[len(raw)-1] != '\n' {
		t.Fatal("文件应以换行结尾")
	}
	if !contains(string(raw), "\n  \"schema\": 1,") {
		t.Fatalf("缩进格式不符：\n%s", string(raw)[:120])
	}
}

func TestStoreUpdateTasks(t *testing.T) {
	dir := t.TempDir()
	st := New(dir)
	if err := st.SaveTasks([]Task{{ID: "task_1", Name: "原名"}}); err != nil {
		t.Fatal(err)
	}
	err := st.UpdateTasks(func(tasks []Task) []Task {
		for i := range tasks {
			tasks[i].Name = "新名"
		}
		return tasks
	})
	if err != nil {
		t.Fatalf("更新失败：%v", err)
	}
	got := New(dir).Tasks()
	if len(got) != 1 || got[0].Name != "新名" {
		t.Fatalf("更新未落盘：%+v", got)
	}
}

// IP 池：同 IP 覆盖，新 IP 追加。
func TestPoolAddEntriesOverwritesDuplicateIP(t *testing.T) {
	pool := []PoolEntry{{IP: "104.16.0.1", Port: 443, Speed: 1.0, At: 1000}}
	incoming := []PoolEntry{
		{IP: "104.16.0.1", Port: 443, Speed: 9.9, At: 2000, TaskName: "新任务"},
		{IP: "104.16.0.2", Port: 443, Speed: 2.0, At: 2000},
	}
	out, added := AddEntries(pool, incoming)
	if len(out) != 2 {
		t.Fatalf("池应有 2 条，实际 %d", len(out))
	}
	if added != 1 {
		t.Fatalf("新增应为 1，实际 %d", added)
	}
	if out[0].Speed != 9.9 || out[0].TaskName != "新任务" {
		t.Fatalf("重复 IP 应被覆盖为最新一轮：%+v", out[0])
	}
}

// IPv6 的大小写写法指向同一地址，归一后必须算同一条。
func TestPoolIPv6CaseInsensitive(t *testing.T) {
	pool := []PoolEntry{{IP: "2606:4700::1", Speed: 1}}
	out, added := AddEntries(pool, []PoolEntry{{IP: "2606:4700:0000::1", Speed: 5}})
	if len(out) != 1 {
		t.Fatalf("同一 IPv6 地址应合并，实际 %d 条", len(out))
	}
	if added != 0 {
		t.Fatalf("IPv6 同址不应算新增，实际 %d", added)
	}
	if out[0].Speed != 5 {
		t.Fatalf("IPv6 同址应被覆盖，实际 %+v", out[0])
	}
}

func TestPoolRemoveEntries(t *testing.T) {
	pool := []PoolEntry{{IP: "1.1.1.1"}, {IP: "2.2.2.2"}, {IP: "3.3.3.3"}}
	out, removed := RemoveEntries(pool, []string{"2.2.2.2"})
	if removed != 1 || len(out) != 2 {
		t.Fatalf("移除结果不符：removed=%d len=%d", removed, len(out))
	}
}

func TestCopyLines(t *testing.T) {
	entries := []PoolEntry{
		{IP: "104.16.0.1", Port: 443, Remark: "IPv4_SJC圣何塞_12_35.5"},
		{IP: "2606:4700::1", Port: 443, Remark: "IPv6_LAX洛杉矶_30_2"},
	}
	lines := CopyLines(entries)
	if lines[0] != "104.16.0.1:443#IPv4_SJC圣何塞_12_35.5" {
		t.Fatalf("IPv4 行格式不符：%s", lines[0])
	}
	// IPv6 必须带方括号，否则端口会被解析错
	if lines[1] != "[2606:4700::1]:443#IPv6_LAX洛杉矶_30_2" {
		t.Fatalf("IPv6 行格式不符：%s", lines[1])
	}
}

func TestSortPoolBySpeedDesc(t *testing.T) {
	pool := []PoolEntry{
		{IP: "1.1.1.1", Speed: 1, Latency: 10},
		{IP: "2.2.2.2", Speed: 5, Latency: 30},
		{IP: "3.3.3.3", Speed: 5, Latency: 20},
	}
	SortPool(pool)
	// 速度相同按延迟升序：3.3.3.3（20ms）应排在 2.2.2.2（30ms）之前
	if pool[0].IP != "3.3.3.3" {
		t.Fatalf("速度相同时应按延迟升序，首条应为 3.3.3.3，实际 %s", pool[0].IP)
	}
	if pool[1].IP != "2.2.2.2" {
		t.Fatalf("速度相同时应按延迟升序，次条应为 2.2.2.2，实际 %s", pool[1].IP)
	}
	if pool[2].IP != "1.1.1.1" {
		t.Fatalf("速度最低的应排最后，实际 %s", pool[2].IP)
	}
}

// 存储目录不存在时应能自动创建。
func TestStoreCreatesDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "dir")
	st := New(dir)
	if err := st.SaveTasks([]Task{{ID: "task_1"}}); err != nil {
		t.Fatalf("应自动创建目录：%v", err)
	}
	if _, err := os.Stat(st.TasksPath()); err != nil {
		t.Fatalf("文件未生成：%v", err)
	}
}

// contains 是测试用的字符串包含判断。
func contains(s, sub string) bool {
	return len(s) >= len(sub) && (len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
