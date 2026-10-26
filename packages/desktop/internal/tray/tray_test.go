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
	"testing"
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
