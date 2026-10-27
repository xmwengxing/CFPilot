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
	"runtime"
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
	// failed 表示托盘启动失败（main 据此降级为无托盘模式）
	failed bool

	// 菜单项句柄
	mStatus *systray.MenuItem
	mURL    *systray.MenuItem
	mPort   *systray.MenuItem
	mOpen   *systray.MenuItem
	mCopy   *systray.MenuItem
	mToggle *systray.MenuItem
	mQuit   *systray.MenuItem
	// mLAN 是「允许局域网访问」的复选菜单项
	mLAN *systray.MenuItem
	// mPortItems 是端口子菜单里的各项，用于打勾标记当前端口
	mPortItems []*systray.MenuItem
	// mCheckAppUpdate 是「检查应用更新」菜单项
	mCheckAppUpdate *systray.MenuItem
	// mCheckDeployUpdate 是「检查部署更新」菜单项
	mCheckDeployUpdate *systray.MenuItem

	// updateState 保存最近一次自动检查的结果（用于菜单项上的提示文字）。
	updateState *UpdateState

	// onOpenUI 回调：打开浏览器到指定地址
	onOpenUI func(url string)
	// onExit 回调：退出整个进程
	onExit func()
	// onCheckAppUpdate 回调：检查应用更新（由 main 注入）
	onCheckAppUpdate func()
	// onCheckDeployUpdate 回调：检查部署更新（由 main 注入）
	onCheckDeployUpdate func()
	// checker 是后台更新检查器（可为 nil）
	checker *UpdateChecker
}

// portChoices 是托盘菜单里可选的端口。
//
// 为什么只给预设值：托盘库没有跨平台输入框，
// 弹系统对话框要各平台写一套，维护成本远大于收益。
// 这几个值避开了常见开发端口（3000/5000/8000/8080/8888 等）。
var portChoices = []int{19726, 19727, 19728, 19729, 19730}

// New 创建托盘应用。
func New(srv *server.Server) *App {
	return &App{srv: srv}
}

// SetOpenHandler 设置「打开界面」的实现（由 main 注入，便于测试替换）。
func (a *App) SetOpenHandler(fn func(url string)) { a.onOpenUI = fn }

// SetExitHandler 设置退出实现。
func (a *App) SetExitHandler(fn func()) { a.onExit = fn }

// SetUpdateChecker 注入后台更新检查器。
func (a *App) SetUpdateChecker(c *UpdateChecker) {
	a.checker = c
	if c != nil {
		c.SetOnChange(func(st *UpdateState) { a.refreshUpdateLabels(st) })
	}
}

// SetCheckAppUpdateHandler 设置「检查应用更新」的实现。
func (a *App) SetCheckAppUpdateHandler(fn func()) { a.onCheckAppUpdate = fn }

// SetCheckDeployUpdateHandler 设置「检查部署更新」的实现。
func (a *App) SetCheckDeployUpdateHandler(fn func()) { a.onCheckDeployUpdate = fn }

// refreshUpdateLabels 按检查结果刷新两个菜单项的标题。
//
// 有新版时把版本号写进标题 —— 用户不用点开就知道。
func (a *App) refreshUpdateLabels(st *UpdateState) {
	if a.mCheckAppUpdate == nil || a.mCheckDeployUpdate == nil {
		return
	}
	if st == nil {
		return
	}
	a.mCheckAppUpdate.SetTitle(menuLabel("检查应用更新", st.AppHasUpdate, st.AppLatest))
	a.mCheckDeployUpdate.SetTitle(menuLabel("检查部署更新", st.DeployHasUpdate, st.DeployLatest))
}

// handleCheckAppUpdate 点击「检查应用更新」。
func (a *App) handleCheckAppUpdate() {
	if a.onCheckAppUpdate != nil {
		a.onCheckAppUpdate()
	}
}

// handleCheckDeployUpdate 点击「检查部署更新」。
func (a *App) handleCheckDeployUpdate() {
	if a.onCheckDeployUpdate != nil {
		a.onCheckDeployUpdate()
	}
}

// Run 启动托盘（阻塞，直到退出）。
//
// ## ⚠️ 托盘失败必须降级，不能让整个程序死掉
//
// systray 在 Windows 上的初始化（建窗口类 / LoadImage 图标 / Shell_NotifyIcon）
// 任何一步失败，消息循环会立刻返回 → systray.Run() 返回 →
// main 走到函数末尾 → **整个进程以 exit code 2 静默退出**。
// 用户看到的现象就是「双击毫无反应，托盘也没图标」。
//
// 实测踩过：托盘图标是手写的假 PNG 字节，LoadImage 失败就整套挂掉，
// 而 `--check`、服务、单测全都正常 —— 极难定位。
//
// 因此这里捕获 panic，并在 Run 返回后由调用方决定是否降级为「无托盘模式」
// （服务继续跑，用户用浏览器访问）。
func (a *App) Run() {
	// ⚠️ **必须锁定 OS 线程**
	//
	// Win32 的窗口类注册、CreateWindowEx、Shell_NotifyIcon 全都绑定在
	// **创建它们的那个 OS 线程**上，且该线程必须有消息队列。
	// Go 的 goroutine 会被运行时在多个 OS 线程间迁移，
	// 一旦 systray 的初始化与消息循环落在线程 A、而后续调用落到线程 B，
	// 就会报 `unable to init instance: Unspecified error` 并且
	// **托盘永远不出现**（进程还活着，只是没图标）。
	//
	// 症状极像「程序没启动」—— 用户双击后什么都没发生，
	// 任务管理器里却能看到进程。锁定线程才能保证全程同一线程。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	defer func() {
		if r := recover(); r != nil {
			log.Printf("[cfpilot] 托盘初始化 panic（已捕获，将降级为无托盘模式）：%v", r)
			a.mu.Lock()
			a.failed = true
			a.mu.Unlock()
		}
	}()
	systray.Run(a.onReady, func() {})
}

// Failed 报告托盘是否启动失败（供 main 决定是否降级）。
func (a *App) Failed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.failed
}

func (a *App) onReady() {
	// 图标加载是 Windows 上最容易崩的一步，单独兜住：
	// 图标坏了最多是托盘没图案，不该连带整个程序退出。
	func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[cfpilot] 托盘图标加载失败（忽略，继续启动菜单）：%v", r)
			}
		}()
		// ⚠️ 必须用 32×32，不能用 16×16
		//
		// systray 在 Windows 上走 `LoadImage(..., IMAGE_ICON, 0, 0, LR_DEFAULTSIZE)`，
		// `LR_DEFAULTSIZE` 会按**系统大图标尺寸**（通常是 32×32）加载。
		// 喂一张 16×16 的 PNG 进去，Windows 会拉伸，且**Alpha 通道在缩放中丢失**
		// → 托盘上只剩一个完全透明的占位符（能看到位置、点得到菜单，但看不见图案）。
		//
		// 32×32 的图标与之尺寸匹配，不做缩放，Alpha 完整保留。
		systray.SetIcon(trayIconBytes())
	}()
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
	a.mOpen = systray.AddMenuItem("打开业务界面", "打开 CFPilot 的部署 / 优选界面")
	a.mCopy = systray.AddMenuItem("复制服务地址", "把当前地址复制到剪贴板")
	a.mToggle = systray.AddMenuItem("停止服务", "启动 / 停止本地服务")

	// ---- 端口（子菜单，预设几个值）----
	//
	// 为什么只给预设值：托盘库没有跨平台输入框。
	// 之前是「跳转到 Web 界面的服务设置区」+ 后来又做成独立页面，
	// 用户反馈「多开一次标签页太繁琐」。
	// 预设几个常用端口，点一下就切换，全程不离开托盘。
	mPortMenu := systray.AddMenuItem("切换端口", "选一个端口，立即生效")
	a.mPortItems = make([]*systray.MenuItem, 0, len(portChoices))
	for _, p := range portChoices {
		item := mPortMenu.AddSubMenuItem(fmt.Sprintf("端口 %d", p), "")
		a.mPortItems = append(a.mPortItems, item)
		port := p
		item.Click(func() { a.switchPort(port) })
	}

	// ---- 更新检查 ----
	//
	// 「检查应用更新」→ 换 exe（外壳 / 界面 / 优选器）
	// 「检查部署更新」→ 换线上内核（数据面 / 控制面）
	//
	// 两个版本独立：外壳可以是 0.7.5 而线上内核还是 0.7.3。
	a.mCheckAppUpdate = systray.AddMenuItem("检查应用更新", "检查是否有新版本可下载")
	a.mCheckDeployUpdate = systray.AddMenuItem("检查部署更新", "检查线上内核是否有新版本")
	a.mCheckAppUpdate.Click(func() { a.onCheckAppUpdate() })
	a.mCheckDeployUpdate.Click(func() { a.onCheckDeployUpdate() })

	// ---- 局域网访问（复选菜单项）----
	a.mLAN = systray.AddMenuItemCheckbox("允许局域网访问", "同一网络的其它设备可访问", false)

	systray.AddSeparator()
	a.mQuit = systray.AddMenuItem("退出 CFPilot", "停止服务并退出")

	a.refresh()

	// ---- 启动提示（气泡通知）----
	//
	// 用户反馈「运行程序后没有任何提示」，不知道有没有起来。
	// 这里在托盘就绪后弹一条气泡（Windows）/ 桌面通知（Linux/macOS），
	// 几秒后自动消失，不打断操作。
	//
	// 延迟 600ms：等托盘图标真正注册进通知区域再弹，
	// 否则 Shell_NotifyIcon 可能因为找不到图标而失败。
	go func() {
		time.Sleep(600 * time.Millisecond)
		a.showStartupNotice()
	}()

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
	// 局域网访问：切换后重建监听（0.0.0.0 ↔ 127.0.0.1）
	a.mLAN.Click(func() { a.toggleLAN() })
	a.mQuit.Click(func() {
		systray.Quit()
		if a.onExit != nil {
			a.onExit()
		}
	})
}

// switchPort 切换监听端口。
//
// 失败时只记录日志并恢复菜单勾选，不弹框打扰（用户点了就知道成没成）。
func (a *App) switchPort(port int) {
	cur := a.srv.Settings().Port
	if port == cur {
		return
	}
	if err := a.srv.UpdatePort(port); err != nil {
		log.Printf("[cfpilot] 切换端口失败：%v", err)
		a.refresh()
		return
	}
	// 切换后地址变了，界面上的「打开」要用新地址 —— refresh 会读最新设置
	a.refresh()
}

// toggleLAN 切换「允许局域网访问」。
func (a *App) toggleLAN() {
	cur := a.srv.Settings()
	next := !cur.AllowLAN

	if err := a.srv.SetAllowLAN(next); err != nil {
		log.Printf("[cfpilot] 切换局域网访问失败：%v", err)
		a.refresh()
		return
	}
	a.refresh()
	if next {
		// 开启后把局域网地址复制进剪贴板，省得用户去找
		st := a.srv.Settings()
		if addrs := a.srv.LocalAddresses(); len(addrs) > 0 {
			url := fmt.Sprintf("http://%s:%d/", addrs[0], st.Port)
			if err := copyToClipboard(url); err == nil {
				log.Printf("[cfpilot] 局域网地址已复制：%s", url)
			}
		}
	}
}

// refresh 把服务真实状态刷到菜单文本上。
//
// ## ⚠️ 菜单项可能还是 nil
//
// SetRunning 会在 systray.Run **之前**被 main 调用（用来告诉托盘
// 「服务已经起来了」），那时 onReady 还没执行，所有菜单项都是 nil。
// 早期实现直接调 SetTitle 就 panic（nil pointer），表现为
// **进程以 exit code 2 静默退出、双击毫无反应**。
//
// 所以这里先判空：菜单没建好就只记状态，等 onReady 末尾再刷一次。
func (a *App) refresh() {
	a.mu.Lock()
	running := a.running
	a.mu.Unlock()

	// 菜单尚未创建（onReady 未执行）
	if a.mStatus == nil || a.mURL == nil || a.mPort == nil || a.mToggle == nil {
		return
	}

	st := a.srv.Settings()

	// 端口子菜单：当前端口打勾，其余取消
	for i, item := range a.mPortItems {
		if i < len(portChoices) && portChoices[i] == st.Port {
			item.Check()
		} else {
			item.Uncheck()
		}
	}

	// 局域网开关的勾选状态
	if a.mLAN != nil {
		if st.AllowLAN {
			a.mLAN.Check()
			a.mLAN.SetTitle("允许局域网访问（已开启）")
		} else {
			a.mLAN.Uncheck()
			a.mLAN.SetTitle("允许局域网访问")
		}
	}

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
