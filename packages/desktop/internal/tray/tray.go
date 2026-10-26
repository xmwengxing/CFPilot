// Package tray 实现托盘图标与菜单。
//
// ## 为什么用 energye/systray 而不是 getlantern/systray
//
// getlantern/systray 在 Linux 上依赖 CGO（GTK/appindicator），
// 交叉编译必须带 Linux 工具链，CI 上要额外装一堆依赖，且产物不静态。
// energye/systray 是纯 Go 实现（Linux 走 D-Bus StatusNotifierItem），
// 实测 GOOS=linux CGO_ENABLED=0 直接编译通过。
//
// ## 托盘菜单要提供什么
//
// 用户明确要求「托盘要有基本的可视化服务状态管理，减少命令行的使用」，
// 所以菜单必须覆盖：
//   - 服务状态（运行中 / 已停止、当前地址、端口、运行时长）
//   - 打开界面（自动带启动令牌）
//   - 复制地址
//   - 换端口（跳转到界面的服务设置区）
//   - 启动 / 停止服务
//   - 退出
package tray

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/energye/systray"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/server"
)

// App 把托盘与服务连起来。
type App struct {
	srv *server.Server

	mu      sync.Mutex
	running bool

	// 菜单项句柄
	mStatus *systray.MenuItem
	mURL    *systray.MenuItem
	mPort   *systray.MenuItem
	mOpen   *systray.MenuItem
	mCopy   *systray.MenuItem
	mToggle *systray.MenuItem
	mQuit   *systray.MenuItem

	// onOpenUI 回调：打开浏览器到指定地址
	onOpenUI func(url string)
	// onExit 回调：退出整个进程
	onExit func()
}

// New 创建托盘应用。
func New(srv *server.Server) *App {
	return &App{srv: srv}
}

// SetOpenHandler 设置「打开界面」的实现（由 main 注入，便于测试替换）。
func (a *App) SetOpenHandler(fn func(url string)) { a.onOpenUI = fn }

// SetExitHandler 设置退出实现。
func (a *App) SetExitHandler(fn func()) { a.onExit = fn }

// Run 启动托盘（阻塞，直到退出）。
func (a *App) Run() {
	systray.Run(a.onReady, func() {})
}

func (a *App) onReady() {
	systray.SetIcon(iconBytes)
	systray.SetTitle("CFPilot")
	systray.SetTooltip("CFPilot 桌面服务")

	// ---- 状态区（不可点，纯展示）----
	a.mStatus = systray.AddMenuItem("服务状态：读取中…", "")
	a.mStatus.Disable()
	a.mURL = systray.AddMenuItem("地址：—", "")
	a.mURL.Disable()
	a.mPort = systray.AddMenuItem("端口：—", "")
	a.mPort.Disable()
	systray.AddSeparator()

	// ---- 操作区 ----
	a.mOpen = systray.AddMenuItem("打开管理界面", "用系统浏览器打开 CFPilot")
	a.mCopy = systray.AddMenuItem("复制服务地址", "把当前地址复制到剪贴板")
	a.mToggle = systray.AddMenuItem("停止服务", "启动 / 停止本地服务")
	systray.AddSeparator()
	mSettings := systray.AddMenuItem("修改端口…", "跳转到界面的服务设置")
	systray.AddSeparator()
	a.mQuit = systray.AddMenuItem("退出 CFPilot", "停止服务并退出")

	a.refresh()

	// 定时刷新运行时长
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for range t.C {
			a.refresh()
		}
	}()

	// ---- 事件回调 ----
	a.mOpen.Click(func() {
		if a.onOpenUI != nil {
			a.onOpenUI(a.srv.WelcomeURL())
		}
	})
	a.mCopy.Click(func() {
		a.copyURL()
		// 给一点视觉反馈（1.5 秒后还原）
		a.mCopy.SetTitle("已复制 ✓")
		time.AfterFunc(1500*time.Millisecond, func() {
			a.mCopy.SetTitle("复制服务地址")
		})
	})
	a.mToggle.Click(func() { a.toggle() })
	mSettings.Click(func() {
		// 托盘库没有跨平台输入框，改为在界面里提供「服务设置」区
		if a.onOpenUI != nil {
			a.onOpenUI(a.srv.WelcomeURL() + "#service")
		}
	})
	a.mQuit.Click(func() {
		systray.Quit()
		if a.onExit != nil {
			a.onExit()
		}
	})
}

// refresh 把服务真实状态刷到菜单文本上。
func (a *App) refresh() {
	a.mu.Lock()
	running := a.running
	a.mu.Unlock()

	st := a.srv.Settings()
	if !running {
		a.mStatus.SetTitle("服务状态：● 已停止")
		a.mURL.SetTitle("地址：—")
		a.mPort.SetTitle(fmt.Sprintf("端口：%d（未监听）", st.Port))
		a.mToggle.SetTitle("启动服务")
		return
	}

	a.mStatus.SetTitle("服务状态：● 运行中")
	a.mURL.SetTitle(fmt.Sprintf("地址：http://%s:%d", st.Host, st.Port))
	a.mPort.SetTitle(fmt.Sprintf("端口：%d（已运行 %s）", st.Port, formatUptime(a.srv.Uptime())))
	a.mToggle.SetTitle("停止服务")
}

// SetRunning 由 main 在启停后调用，让菜单立刻反映状态。
func (a *App) SetRunning(v bool) {
	a.mu.Lock()
	a.running = v
	a.mu.Unlock()
	a.refresh()
}

func (a *App) toggle() {
	a.mu.Lock()
	running := a.running
	a.mu.Unlock()

	if running {
		if err := a.srv.Stop(); err != nil {
			log.Printf("[cfpilot] 停止失败：%v", err)
		}
		a.SetRunning(false)
		return
	}
	if err := a.srv.Start(); err != nil {
		log.Printf("[cfpilot] 启动失败：%v", err)
		a.SetRunning(false)
		return
	}
	a.SetRunning(true)
}

func (a *App) copyURL() {
	url := fmt.Sprintf("http://%s:%d/", a.srv.Settings().Host, a.srv.Settings().Port)
	if err := copyToClipboard(url); err != nil {
		log.Printf("[cfpilot] 复制失败：%v", err)
	}
}

func formatUptime(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%d 分钟", int(d.Minutes()))
	}
	return fmt.Sprintf("%d 小时 %d 分", int(d.Hours()), int(d.Minutes())%60)
}
