package tray

// 托盘的状态刷新测试。
//
// ## 为什么需要这个测试
//
// 这里曾经有个致命 bug：main 在 `systray.Run` **之前**就调
// `app.SetRunning(true)`，而 SetRunning → refresh → mStatus.SetTitle(...)，
// 此时菜单项还全是 nil → **nil pointer panic** →
// 进程以 exit code 2 静默退出，用户双击 exe 后**毫无反应，托盘也没图标**。
//
// 这个 bug 只有真机双击才能发现：`--check` 能过、服务能起、
// go test 全绿、go vet 干净 —— 因为 panic 发生在 GUI 初始化路径上，
// 而在无桌面会话的测试环境里那条路径根本不会被执行。
//
// 因此这里把「菜单未建好时调 SetRunning 不能崩」明确固化成测试。

import (
	"strings"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/server"
)

// 菜单项尚未创建（onReady 未执行）时调 SetRunning 必须安全。
//
// 对应 main.go 里 `app.SetRunning(true)` 早于 `app.Run()` 的真实调用顺序。
func TestSetRunningBeforeMenuCreated(t *testing.T) {
	app := &App{} // 所有菜单项都是 nil，模拟 onReady 之前的真实状态

	// 不能 panic
	app.SetRunning(true)
	app.SetRunning(false)

	if app.running {
		t.Error("SetRunning(false) 后 running 应为 false")
	}
}

// refresh 在菜单未建好时必须是安全的空操作。
func TestRefreshWithoutMenu(t *testing.T) {
	app := &App{}

	// 不能 panic —— 这就是当初崩的地方
	app.refresh()

	// 只设了部分菜单项也要安全（防御性：将来若有人只初始化一部分）
	app2 := &App{}
	app2.refresh()
}

// Failed 的读写要并发安全（定时刷新 goroutine 与主线程会同时访问）。
func TestFailedAccessor(t *testing.T) {
	app := &App{}
	if app.Failed() {
		t.Error("初始状态应为 false")
	}

	app.mu.Lock()
	app.failed = true
	app.mu.Unlock()

	if !app.Failed() {
		t.Error("设置后应返回 true")
	}
}

// New 创建的 App 初始状态正确。
func TestNewApp(t *testing.T) {
	// 这里只需要一个非 nil 的 *App；srv 在 refresh 判空后才会用到，
	// 而菜单未建好时 refresh 会提前 return，不会解引用 srv。
	app := New(nil)
	if app == nil {
		t.Fatal("New 不该返回 nil")
	}
	if app.Failed() {
		t.Error("新建的 App 不该是 failed 状态")
	}
	// 菜单未建好时调 refresh 不能因其 srv 为 nil 而崩
	app.refresh()
}

// ---------- 一键优选：纯逻辑 ----------
//
// 这些函数是托盘「一键优选 IP」子菜单与进度显示的核心。
// 抽成纯函数单独测的理由：
//   - 菜单本身要靠真机托盘才能跑起来（无桌面会话的 CI 里建不出 systray），
//     但槽位映射 / 标题格式化 / 百分比 / 里程碑这些逻辑出错时
//     表现是「点了跑错账号」「进度不动」「气泡刷屏」—— 都能在这里测出来。

// progressPercent：当前阶段百分比，边界要钳住。
func TestProgressPercent(t *testing.T) {
	cases := []struct {
		done, total, want int
	}{
		{0, 0, 0},       // 没有总数（回填阶段）
		{0, 1500, 0},    //
		{45, 1500, 3},   // 3%
		{750, 1500, 50}, //
		{1500, 1500, 100},
		{2000, 1500, 100}, // 收尾事件可能越界，必须钳到 100
		{-5, 1500, 0},     // 防御负数
	}
	for _, c := range cases {
		if got := progressPercent(c.done, c.total); got != c.want {
			t.Errorf("progressPercent(%d,%d)=%d，期望 %d", c.done, c.total, got, c.want)
		}
	}
}

// accountLabel：<账号名> · <账号ID前8位>，且不重复拼接。
func TestAccountLabel(t *testing.T) {
	cases := []struct {
		name, accountID, profileID, want string
	}{
		{"主账号", "abcdef1234567890", "acc_1111", "主账号 · abcdef12"},
		{"主账号", "abcdef12", "", "主账号 · abcdef12"},
		// 账号名里已经带了这个前缀（凭据库自动推导的名字就是这样）→ 不重复拼
		{"账户 abcdef12", "abcdef123456", "", "账户 abcdef12"},
		// 账号名为空 → 「账户」
		{"", "abcdef123456", "", "账户 · abcdef12"},
		// 账号 ID 为空 → 用 profile ID 兜底（保证菜单项之间能区分）
		{"主账号", "", "acc_9f8e7d6c", "主账号 · acc_9f8e"},
		// 全都为空 → 至少不是空标题
		{"", "", "", "账户"},
	}
	for _, c := range cases {
		if got := accountLabel(c.name, c.accountID, c.profileID); got != c.want {
			t.Errorf("accountLabel(%q,%q,%q)=%q，期望 %q", c.name, c.accountID, c.profileID, got, c.want)
		}
	}
}

// quickScanTitle / quickScanTitleIdle / quickScanTooltip：菜单标题与提示文字。
func TestQuickScanTitle(t *testing.T) {
	if got := quickScanTitleIdle(0); !strings.Contains(got, "暂无账号") {
		t.Errorf("没有账号时标题应提示「暂无账号」，实际 %q", got)
	}
	if got := quickScanTitleIdle(2); got != "一键优选 IP" {
		t.Errorf("有账号时标题应为「一键优选 IP」，实际 %q", got)
	}

	cases := []struct {
		p    scan.Progress
		want string
	}{
		{scan.Progress{Stage: "tcp", Done: 45, Total: 1500}, "一键优选：扫描 45/1500 · 3%"},
		{scan.Progress{Stage: "tls", Done: 100, Total: 200}, "一键优选：TLS 握手 100/200 · 50%"},
		{scan.Progress{Stage: "probe", Done: 120, Total: 120}, "一键优选：WS 校验 120/120 · 100%"},
		// 没有总数的阶段（回填）只显示阶段名
		{scan.Progress{Stage: "push", Message: "正在回填面板"}, "一键优选：回填…"},
		{scan.Progress{Stage: "prepare"}, "一键优选：读取清单…"},
		// 未知阶段给个中性文案，不能空标题
		{scan.Progress{Stage: "future", Done: 5, Total: 10}, "一键优选：进行中 5/10 · 50%"},
		// 越界也要合理
		{scan.Progress{Stage: "tcp", Done: 2000, Total: 1500}, "一键优选：扫描 1500/1500 · 100%"},
	}
	for _, c := range cases {
		if got := quickScanTitle(c.p); got != c.want {
			t.Errorf("quickScanTitle(%+v)=%q，期望 %q", c.p, got, c.want)
		}
	}

	if got := quickScanTooltip(scan.Progress{Stage: "tcp", Done: 45, Total: 1500, Message: "阶段一：TCP 握手初筛"}); got != "阶段一：TCP 握手初筛（45/1500，3%）" {
		t.Errorf("tooltip 应带阶段说明与计数，实际 %q", got)
	}
	if got := quickScanTooltip(scan.Progress{Stage: "push", Message: "正在回填面板"}); got != "正在回填面板" {
		t.Errorf("tooltip 应回退到 Message，实际 %q", got)
	}
}

// overallPercent：各阶段折算成整体进度，必须**单调不减**（里程碑依赖它）。
func TestOverallPercentMonotonic(t *testing.T) {
	// 单点断言：阶段切换处首尾相接
	cases := []struct {
		stage string
		done  int
		total int
		want  int
	}{
		{"tcp", 0, 1500, 0},
		{"tcp", 1500, 1500, 60},
		{"tls", 0, 300, 60},
		{"tls", 300, 300, 85},
		{"probe", 0, 120, 85},
		{"probe", 120, 120, 95},
		{"push", 0, 0, 95},
		// 未知阶段不参与里程碑
		{"prepare", 0, 0, 0},
	}
	for _, c := range cases {
		if got := overallPercent(c.stage, c.done, c.total); got != c.want {
			t.Errorf("overallPercent(%s,%d,%d)=%d，期望 %d", c.stage, c.done, c.total, got, c.want)
		}
	}

	// 整条事件流：模拟真实的阶段推进，整体进度不能倒退
	var events []struct {
		stage string
		done  int
		total int
	}
	for d := 0; d <= 1500; d += 150 {
		events = append(events, struct {
			stage string
			done  int
			total int
		}{"tcp", d, 1500})
	}
	for d := 0; d <= 300; d += 30 {
		events = append(events, struct {
			stage string
			done  int
			total int
		}{"tls", d, 300})
	}
	for d := 0; d <= 120; d += 12 {
		events = append(events, struct {
			stage string
			done  int
			total int
		}{"probe", d, 120})
	}
	prev := -1
	for _, e := range events {
		got := overallPercent(e.stage, e.done, e.total)
		if got < prev {
			t.Fatalf("整体进度倒退了：%s %d/%d → %d%%（上一次 %d%%）", e.stage, e.done, e.total, got, prev)
		}
		prev = got
	}
	if prev != 95 {
		t.Errorf("探测阶段结束时整体进度应为 95%%，实际 %d%%", prev)
	}
}

// quickScanMilestone：跨档才返回新值（这是「气泡不刷屏」的关键）。
func TestQuickScanMilestone(t *testing.T) {
	cases := []struct {
		pct, want int
	}{
		{0, 0}, {10, 0}, {24, 0},
		{25, 25}, {26, 25}, {49, 25},
		{50, 50}, {74, 50},
		{75, 75}, {99, 75}, {100, 75},
	}
	for _, c := range cases {
		if got := quickScanMilestone(c.pct); got != c.want {
			t.Errorf("quickScanMilestone(%d)=%d，期望 %d", c.pct, got, c.want)
		}
	}

	// 模拟一次真实扫描的整体进度序列：只应跨档 3 次（25/50/75），
	// 其余 99% 的进度回调都不能触发气泡。
	pcts := []int{0, 5, 12, 20, 25, 26, 30, 42, 50, 55, 60, 61, 70, 75, 80, 95}
	last := 0
	balloons := 0
	for _, pct := range pcts {
		cur := quickScanMilestone(pct)
		if cur > last {
			balloons++
			last = cur
		}
	}
	if balloons != 3 || last != 75 {
		t.Errorf("一次扫描应只在 25/50/75 各弹一条气泡（共 3 条，最高 75），实际 %d 条 / 最高 %d", balloons, last)
	}
}

// planQuickScanAccounts：账号列表 → 固定槽位池的映射。
func TestPlanQuickScanAccounts(t *testing.T) {
	accounts := []server.QuickScanAccount{
		{ID: "acc_1", Name: "主账号", AccountID: "abcdef1234567890", Active: true},
		{ID: "acc_2", Name: "备用", AccountID: "1234567890abcdef"},
	}

	plan := planQuickScanAccounts(accounts, quickScanSlotCount)
	if len(plan.Slots) != quickScanSlotCount {
		t.Fatalf("槽位数应固定为 %d，实际 %d", quickScanSlotCount, len(plan.Slots))
	}
	if plan.Total != 2 {
		t.Errorf("账号总数应为 2，实际 %d", plan.Total)
	}
	if plan.MoreVisible {
		t.Error("账号数没超过槽位池，不该显示「更多账号」")
	}

	want0 := quickScanAccountSlot{Visible: true, Title: "主账号 · abcdef12", Checked: true, ID: "acc_1"}
	if plan.Slots[0] != want0 {
		t.Errorf("槽位 0 = %+v，期望 %+v", plan.Slots[0], want0)
	}
	want1 := quickScanAccountSlot{Visible: true, Title: "备用 · 12345678", Checked: false, ID: "acc_2"}
	if plan.Slots[1] != want1 {
		t.Errorf("槽位 1 = %+v，期望 %+v", plan.Slots[1], want1)
	}
	for i := 2; i < quickScanSlotCount; i++ {
		if plan.Slots[i].Visible {
			t.Errorf("槽位 %d 没账号，不该可见：%+v", i, plan.Slots[i])
		}
	}

	// 账号数超过槽位池：只显示前 N 个 + 兜底提示项
	many := make([]server.QuickScanAccount, 0, 12)
	for i := 0; i < 12; i++ {
		many = append(many, server.QuickScanAccount{ID: "acc_x", Name: "账号"})
	}
	plan = planQuickScanAccounts(many, 8)
	if !plan.MoreVisible {
		t.Fatal("账号数超过槽位池时要显示兜底提示项")
	}
	if !strings.Contains(plan.MoreTitle, "12") || !strings.Contains(plan.MoreTitle, "界面") {
		t.Errorf("兜底提示应说明账号总数并引导去界面操作，实际 %q", plan.MoreTitle)
	}

	// 一个账号都没有：全部隐藏 + 父项标题提示「暂无账号」
	plan = planQuickScanAccounts(nil, quickScanSlotCount)
	if plan.Total != 0 || plan.MoreVisible {
		t.Errorf("空账号列表的期望状态不对：%+v", plan)
	}
	for i, slot := range plan.Slots {
		if slot.Visible {
			t.Errorf("槽位 %d 不该可见：%+v", i, slot)
		}
	}
	if quickScanTitleIdle(plan.Total) != "一键优选 IP（暂无账号）" {
		t.Errorf("空账号时父项标题应为「一键优选 IP（暂无账号）」")
	}

	// 防御：槽位池为 0 时不能 panic
	plan = planQuickScanAccounts(accounts, 0)
	if len(plan.Slots) != 0 || !plan.MoreVisible {
		t.Errorf("槽位池为 0 时应只显示兜底提示项，实际 %+v", plan)
	}
}

// diffQuickScanSlot：差量更新规则。
//
// 最关键的一条：**期望隐藏时只能 Hide**。
// systray 在 Windows 上的 addOrUpdateMenuItem 会把「不在 visibleItems 里」
// 的项重新 InsertMenuItem —— 对隐藏槽位调 SetTitle / Check / Enable
// 会让它变成一行可见的空白菜单项。
func TestDiffQuickScanSlot(t *testing.T) {
	visible := quickScanAccountSlot{Visible: true, Title: "主账号 · abcdef12", Checked: false, ID: "acc_1"}
	hidden := quickScanAccountSlot{}
	shownChecked := visible
	shownChecked.Checked = true

	// 可见 → 隐藏：只 Hide，绝不能带出 SetTitle / Check 之类的操作
	if d := diffQuickScanSlot(hidden, visible); !d.Hide || d.Title != "" || d.Checked != nil || d.Show {
		t.Errorf("隐藏槽位只能产生 Hide，实际 %+v", d)
	}
	// 隐藏 → 隐藏：什么都不做
	if d := diffQuickScanSlot(hidden, hidden); d.Hide || d.Show || d.Title != "" || d.Checked != nil {
		t.Errorf("已隐藏的槽位不该产生任何更新，实际 %+v", d)
	}
	// 隐藏 → 可见：先改标题/勾选，再 Show
	if d := diffQuickScanSlot(shownChecked, hidden); !d.Show || d.Title != shownChecked.Title || d.Checked == nil || !*d.Checked {
		t.Errorf("新出现的账号应同时改标题、打勾并 Show，实际 %+v", d)
	}
	// 可见且标题/勾选都没变：什么都不做（每 10 秒的刷新不应闪烁）
	if d := diffQuickScanSlot(visible, visible); d.Hide || d.Show || d.Title != "" || d.Checked != nil {
		t.Errorf("状态没变时不该产生任何更新，实际 %+v", d)
	}
	// 只改勾选
	if d := diffQuickScanSlot(shownChecked, visible); d.Checked == nil || !*d.Checked || d.Show || d.Title != "" {
		t.Errorf("打勾变化应只产生 Check，实际 %+v", d)
	}
	// 只改标题
	renamed := visible
	renamed.Title = "主账号 · 改名了"
	if d := diffQuickScanSlot(renamed, visible); d.Title != renamed.Title || d.Show || d.Checked != nil {
		t.Errorf("改标题应只产生 SetTitle，实际 %+v", d)
	}
}

// 槽位 → 账号映射必须来自「上次渲染菜单时的快照」，
// 不能按数组下标重新读凭据库（菜单打开期间删账号会导致点 A 跑 B）。
func TestQuickScanSlotMappingFromAppliedPlan(t *testing.T) {
	app := &App{qsApplied: planQuickScanAccounts([]server.QuickScanAccount{
		{ID: "acc_1", Name: "主账号", AccountID: "abcdef1234567890", Active: true},
		{ID: "acc_2", Name: "备用", AccountID: "1234567890abcdef"},
	}, quickScanSlotCount)}

	if got := app.qsApplied.Slots[0].ID; got != "acc_1" {
		t.Errorf("槽位 0 应映射 acc_1，实际 %q", got)
	}
	if got := app.qsApplied.Slots[1].ID; got != "acc_2" {
		t.Errorf("槽位 1 应映射 acc_2，实际 %q", got)
	}
	// 空槽位：点击必须被忽略（不 panic、不误跑别的账号）
	if got := app.qsApplied.Slots[5].ID; got != "" {
		t.Errorf("空槽位不该有账号 ID，实际 %q", got)
	}
}

// 菜单 / 托盘尚未建好时，进度与结束回调必须是安全的空操作。
//
// 对应真实场景：main 注入的一键优选可能在托盘初始化完成前就被调用
// （例如命令行触发），此时所有 *systray.MenuItem 都是 nil。
func TestQuickScanCallbacksWithoutMenu(t *testing.T) {
	app := &App{}

	// 不能 panic
	app.SetQuickScanProgress(scan.Progress{Stage: "tcp", Done: 45, Total: 1500})
	app.FinishQuickScan(server.QuickScanResult{OK: false, Error: "测试"})
	app.refreshQuickScanMenu()

	// 没在运行时，进度回调不该改任何状态
	app.qsMu.Lock()
	running := app.quickScanRunning
	app.qsMu.Unlock()
	if running {
		t.Error("进度回调不该让 App 进入运行态")
	}
}

// 运行中重复点账号项必须被忽略（同一时刻只跑一个）。
func TestHandleQuickScanSlotIgnoresWhenRunning(t *testing.T) {
	called := false
	app := &App{
		onQuickScan:      func(string) { called = true },
		quickScanRunning: true,
		qsApplied: planQuickScanAccounts([]server.QuickScanAccount{
			{ID: "acc_1", Name: "主账号", AccountID: "abcdef1234567890"},
		}, quickScanSlotCount),
	}

	app.handleQuickScanSlot(0)
	if called {
		t.Error("运行中再点账号项不该再触发一次扫描")
	}
}

// 点击槽位选中的是**该槽位对应的账号 ID**（不是活跃账号，也不是
// 现在重新按下标读凭据库），并且第二次点击必须被忽略。
func TestBeginQuickScanSlotSelectsAccount(t *testing.T) {
	app := &App{qsApplied: planQuickScanAccounts([]server.QuickScanAccount{
		{ID: "acc_1", Name: "主账号", AccountID: "abcdef1234567890", Active: true},
		{ID: "acc_2", Name: "备用", AccountID: "1234567890abcdef"},
	}, quickScanSlotCount)}

	slotInfo, ok := app.beginQuickScanSlot(1)
	if !ok {
		t.Fatal("点有账号的槽位应当开始扫描")
	}
	if slotInfo.ID != "acc_2" {
		t.Errorf("槽位 1 应当对应 acc_2，实际 %q", slotInfo.ID)
	}
	if slotInfo.Title != "备用 · 12345678" {
		t.Errorf("槽位标题应带账号名与账号ID前8位，实际 %q", slotInfo.Title)
	}

	app.qsMu.Lock()
	running := app.quickScanRunning
	app.qsMu.Unlock()
	if !running {
		t.Error("开始后必须进入运行态（账号项要被置灰）")
	}

	// 运行中再点别的账号：必须被忽略（同一时刻只跑一个）
	if _, ok := app.beginQuickScanSlot(0); ok {
		t.Error("运行中再点账号项不该再开始一次扫描")
	}
}

// 点击空槽位必须被忽略（账号变少后残留的菜单项可能还在）。
func TestHandleQuickScanSlotIgnoresEmptySlot(t *testing.T) {
	called := false
	app := &App{
		onQuickScan: func(string) { called = true },
		qsApplied: planQuickScanAccounts([]server.QuickScanAccount{
			{ID: "acc_1", Name: "主账号", AccountID: "abcdef1234567890"},
		}, quickScanSlotCount),
	}

	app.handleQuickScanSlot(5)
	app.handleQuickScanSlot(-1)
	if called {
		t.Error("点击空槽位不该触发扫描")
	}
}
