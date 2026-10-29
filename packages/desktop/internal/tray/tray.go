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
//   - 一键优选 IP（按账号执行，运行中在菜单标题上显示进度）
//   - 退出
package tray

import (
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/energye/systray"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
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
	// mQuickScan 是「一键优选 IP」父项。
	//
	// 它同时是**账号子菜单的容器**与**进度显示器**：
	// 平时标题是「一键优选 IP」，运行中变成「一键优选：扫描 45/1500 · 3%」。
	mQuickScan *systray.MenuItem
	// mQuickScanSlots 是账号子菜单的固定槽位池。
	//
	// ⚠️ 必须预创建：systray v1.0.3 的 MenuItem **没有 Remove**，
	// 菜单项一旦创建就只能 Show / Hide（理由见 onReady 里的详细注释）。
	mQuickScanSlots []*systray.MenuItem
	// mQuickScanMore 是账号数超过槽位池时的兜底提示项（常驻灰色，不可点）
	mQuickScanMore *systray.MenuItem

	// qsMu 保护「一键优选」的菜单状态与进度状态。
	//
	// 进度回调来自扫描 goroutine（逐候选一次，每秒几十次），
	// 而 refresh() 在另一个 goroutine 每 10 秒跑一次 —— 两者都会改菜单项
	// 与 qsApplied，必须串行。
	qsMu sync.Mutex
	// quickScanRunning 表示托盘视角下正在跑一键优选
	quickScanRunning bool
	// quickScanMilestone 是已经弹过气泡的最高里程碑（25/50/75，0 = 还没到 25%）
	quickScanMilestone int
	// quickScanSlotsDisabled 表示账号槽位当前是否处于「运行中置灰」状态
	quickScanSlotsDisabled bool
	// quickScanLastTitleAt 是上次刷新进度标题的时刻（节流用）
	quickScanLastTitleAt time.Time
	// quickScanLastStage 是上次刷标题时的阶段（换阶段立刻刷，不受节流限制）
	quickScanLastStage string
	// qsApplied 是账号子菜单**上次应用**的状态，用于差量更新。
	//
	// 每 10 秒的定时刷新不应该反复 Hide/Show（菜单开着时会跳动），
	// 更关键的是 Windows 上对隐藏项调 SetTitle 会把它重新插回菜单。
	qsApplied quickScanAccountPlan

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
	// onQuickScan 回调：用指定账号跑一键优选（由 main 注入）。
	//
	// 参数是账号 ID（凭据库的 profile ID）：托盘菜单点了哪个账号就传哪个，
	// **不是**「当前活跃账号」。main 侧负责：
	//  1. 用该账号跑 RunQuickScanFor；
	//  2. 把进度转给 SetQuickScanProgress；
	//  3. 无论成功失败都调 FinishQuickScan 恢复菜单。
	//
	// ⚠️ 托盘在**独立 goroutine** 里调用它，实现可以直接同步跑（不必再起 goroutine）。
	onQuickScan func(profileID string)
	// checker 是后台更新检查器（可为 nil）
	checker *UpdateChecker
}

// portChoices 是托盘菜单里可选的端口。
//
// 为什么只给预设值：托盘库没有跨平台输入框，
// 弹系统对话框要各平台写一套，维护成本远大于收益。
// 这几个值避开了常见开发端口（3000/5000/8000/8080/8888 等）。
var portChoices = []int{19726, 19727, 19728, 19729, 19730}

// 「一键优选 IP」相关常量。
const (
	// quickScanSlotCount 是账号子菜单的固定槽位数量。
	//
	// 为什么是 8：systray 没有 Remove（见 onReady 里的注释），只能预创建；
	// 8 个足够覆盖绝大多数用户（多账号场景通常 2~4 个），
	// 超出时用「更多账号请在界面操作」兜底提示。
	quickScanSlotCount = 8

	// quickScanTitleInterval 是运行中标题刷新的最小间隔。
	//
	// 扫描进度是**逐候选**回调的（阶段一就有 1500 个候选），
	// 不节流会每秒打几十次 Win32 SetMenuItemInfo，菜单开着时还会闪。
	// 约 3 次/秒足够看出「在动」，又不至于卡顿。
	quickScanTitleInterval = 300 * time.Millisecond

	// trayTooltipIdle 是托盘图标的常态 tooltip（运行中会被替换成进度）。
	trayTooltipIdle = "CFPilot 桌面服务"

	// quickScanPlaceholderTitle 是槽位创建时的占位标题（创建后立刻 Hide）。
	//
	// 用非空标题而不是空串：万一 Hide 失败，也只是一行灰字而不是一行空白。
	quickScanPlaceholderTitle = "账号"
)

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

// SetQuickScanHandler 设置「一键优选 IP」的实现（由 main 注入）。
//
// 参数是账号 ID：用户在子菜单里点哪个账号，就用哪个账号跑
// （多账号用户的优选结果必须回填到**各自的面板**，不能只认活跃账号）。
func (a *App) SetQuickScanHandler(fn func(profileID string)) { a.onQuickScan = fn }

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
	systray.SetTooltip(trayTooltipIdle)

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
	a.mCheckAppUpdate.Click(func() { a.handleCheckAppUpdate() })
	a.mCheckDeployUpdate.Click(func() { a.handleCheckDeployUpdate() })

	// ---- 一键优选（子菜单：每个已保存账号一项）----
	//
	// ## 为什么是子菜单
	//
	// 用户要求「点哪个账号就用哪个账号跑」。多账号用户的优选结果必须
	// 回填到**各自的面板**（每个账号有自己的 KV 清单与部署），
	// 所以「一键优选 IP」不能只认活跃账号，要能选账号。
	//
	// ## 为什么用固定槽位池，而不是每次重建菜单
	//
	// systray v1.0.3 的 MenuItem **没有 Remove**：菜单项一旦创建就删不掉，
	// 只提供 Hide / Show。所以这里预创建 quickScanSlotCount 个槽位，
	// 之后按账号列表给每个槽位 SetTitle + Show/Hide + Check/Uncheck。
	//
	// 实测（读 v1.0.3 源码）：
	//   - Windows：Hide() = RemoveMenu；Show() 走 addOrUpdateMenuItem 重新
	//     InsertMenuItem，位置由 visibleItems（按菜单项 ID 排序）算出 ——
	//     所以隐藏后再显示仍回到原位置，反复刷新不会跳序；
	//   - Linux：Hide/Show 改的是 D-Bus 菜单的 "visible" 属性，同样可用。
	//
	// ⚠️ **隐藏的槽位不能调 SetTitle / Enable / Disable / Check**：
	// 这些方法都会触发 systray 的 update()，而 Windows 的 addOrUpdateMenuItem
	// 对「不在 visibleItems 里」的项会**重新插回菜单** —— 隐藏的空槽位
	// 会因此变成一行可见的空白项。所有状态更新必须先看可见性，
	// 见 diffQuickScanSlot 的注释。
	a.mQuickScan = systray.AddMenuItem("一键优选 IP", "自动优选并回填到面板，完成后通知")
	a.mQuickScanSlots = make([]*systray.MenuItem, 0, quickScanSlotCount)
	for i := 0; i < quickScanSlotCount; i++ {
		slot := i
		item := a.mQuickScan.AddSubMenuItem(quickScanPlaceholderTitle, "")
		item.Hide()
		item.Click(func() { a.handleQuickScanSlot(slot) })
		a.mQuickScanSlots = append(a.mQuickScanSlots, item)
	}
	// 账号数超过槽位池时的兜底提示项。常驻灰色（它只是个提示，不可点）。
	a.mQuickScanMore = a.mQuickScan.AddSubMenuItem("更多账号请在界面操作", "账号太多，剩下的请在界面「凭据」页选择")
	a.mQuickScanMore.Disable()
	a.mQuickScanMore.Hide()

	// 初始「已应用状态」= 全部隐藏，与上面创建的视觉状态一致；
	// 之后 refresh() 按真实账号列表做差量更新。
	a.qsApplied = planQuickScanAccounts(nil, quickScanSlotCount)

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

	// 「一键优选 IP」子菜单跟随凭据库里的账号列表
	// （用户在界面里加了 / 删了账号，托盘最多 10 秒内跟上）
	a.refreshQuickScanMenu()

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

// ---------- 一键优选 IP（按账号执行 + 进度感知） ----------

// handleQuickScanSlot 点击某个账号槽位：用**该账号**跑一键优选。
//
// 槽位 → 账号的映射来自「上次渲染菜单时」记录的 qsApplied，
// 不是「现在重新读一遍凭据库、再按数组下标取账号」——
// 后者在菜单打开期间用户在界面删了个账号时会张冠李戴，
// 把 A 账号的优选结果回填到 B 账号的面板（串号）。
func (a *App) handleQuickScanSlot(slot int) {
	slotInfo, ok := a.beginQuickScanSlot(slot)
	if !ok {
		return
	}

	// 父项立刻给出反馈：用户点了之后菜单不会「像什么都没发生」
	if a.mQuickScan != nil {
		a.mQuickScan.SetTitle("一键优选：准备中…")
		a.mQuickScan.SetTooltip("正在准备扫描…")
	}
	systray.SetTooltip("CFPilot：正在准备一键优选…")

	// 开始气泡（进度本身在菜单标题上，气泡只负责「我收到你的点击了」）
	a.showBalloonQuiet("CFPilot 一键优选开始",
		fmt.Sprintf("正在用「%s」优选 IP，预计 1~3 分钟。\n进度实时显示在托盘菜单的「一键优选 IP」上。", slotInfo.Title))

	// 在独立 goroutine 里跑，绝不阻塞托盘消息循环
	// （扫描要 1~3 分钟，阻塞 UI 线程会让整个托盘失去响应）。
	go func() {
		defer func() {
			if r := recover(); r != nil {
				// 兜底：注入的实现 panic 时也要把菜单恢复回来，
				// 否则账号项永远灰着、标题永远停在进度上，只能重启程序。
				log.Printf("[cfpilot] 一键优选 panic（已捕获）：%v", r)
				a.FinishQuickScan(server.QuickScanResult{
					OK:    false,
					Error: "优选过程发生内部错误，详情见日志",
				})
			}
		}()
		if a.onQuickScan == nil {
			a.FinishQuickScan(server.QuickScanResult{OK: false, Error: "托盘未注入一键优选实现"})
			return
		}
		a.onQuickScan(slotInfo.ID)
	}()
}

// beginQuickScanSlot 校验槽位、进入运行态并置灰账号项，返回这次要跑的账号。
//
// 抽出来是为了能单测「点击 → 选中账号 / 忽略重复点击 / 忽略空槽位」
// 这段状态机，而不必真的建出 systray 菜单（菜单只能靠真机托盘验证）。
// ok=false 表示这次点击应当被忽略（运行中 / 空槽位）。
func (a *App) beginQuickScanSlot(slot int) (quickScanAccountSlot, bool) {
	a.qsMu.Lock()
	defer a.qsMu.Unlock()

	if a.quickScanRunning {
		// 运行中忽略：账号项本已 Disable，这里再兜一层
		// （Disable 之后的点击消息在某些系统上仍可能到达）。
		return quickScanAccountSlot{}, false
	}
	var slotInfo quickScanAccountSlot
	if slot >= 0 && slot < len(a.qsApplied.Slots) {
		slotInfo = a.qsApplied.Slots[slot]
	}
	if !slotInfo.Visible || slotInfo.ID == "" {
		// 空槽位（账号数变少 / 菜单刚刷新过的残留点击）
		return quickScanAccountSlot{}, false
	}
	a.quickScanRunning = true
	a.quickScanMilestone = 0
	a.quickScanLastTitleAt = time.Time{}
	a.quickScanLastStage = ""
	// 运行期间账号项全部置灰 —— 同一时刻只跑一个，不能重复点。
	a.setQuickScanSlotsEnabledLocked(false)
	return slotInfo, true
}

// SetQuickScanProgress 由 main 在服务端进度回调里调用。
//
// ## ⚠️ 为什么气泡里没有进度条（结论）
//
// Windows 的托盘气泡走 Shell_NotifyIcon(NIM_MODIFY) + NOTIFYICONDATAW：
// 正文是 uint16[256]、标题是 uint16[64]，**结构里根本没有进度字段**，
// 只能显示文本 + 一个系统图标（信息 / 警告 / 错误）。
// 这是 Win32 API 的硬限制，不是 systray 库少实现了什么。
//
// 也没有「给托盘应用加任务栏进度条」的通道：ITaskbarList3.SetProgressValue
// 只对**有可见窗口、且任务栏上能对上的程序**生效（通常还要安装快捷方式 +
// AppUserModelID）。本项目是绿色单文件、没有主窗口（托盘窗口是隐藏的），
// 系统不会给它显示任务栏进度。Windows 10/11 的 Toast 通知同样要求
// AppUserModelID + 开始菜单快捷方式，否则会被静默丢弃（见 balloon_windows.go）。
//
// 所以这里选的可感知方案是：
//  1. **父项菜单标题实时显示进度**：如「一键优选：扫描 45/1500 · 3%」
//     —— 用户点开托盘菜单就能看到，刷新节流到约 3 次/秒。
//     ⚠️ Win32 的弹出菜单是**打开瞬间的快照**：菜单开着时改标题不会重绘，
//     用户下次打开菜单看到的就是最新进度（悬停图标看 tooltip 则是实时的）。
//  2. 托盘图标 tooltip 同步显示进度：鼠标停在图标上就能看到，不必点开菜单
//     （Windows 上菜单项 tooltip 不显示，systray 没把它传给 Win32）；
//  3. 在 开始 / 25% / 50% / 75% / 完成 各弹一条**文本气泡**：
//     气泡画不了进度条，但能告知「到哪一步了」，不用一直盯着菜单。
func (a *App) SetQuickScanProgress(p scan.Progress) {
	if a.mQuickScan == nil {
		return
	}

	now := time.Now()
	overall := overallPercent(p.Stage, p.Done, p.Total)

	a.qsMu.Lock()
	if !a.quickScanRunning {
		a.qsMu.Unlock()
		return
	}
	// 换阶段必须立刻刷（否则「阶段二」开始后标题还停在阶段一最后一帧）；
	// 同一阶段内按时间节流 —— 逐候选回调每秒几十次，不节流会把
	// Win32 SetMenuItemInfo 打爆，菜单开着时还会闪烁。
	titleDue := p.Stage != a.quickScanLastStage || now.Sub(a.quickScanLastTitleAt) >= quickScanTitleInterval
	if titleDue {
		a.quickScanLastTitleAt = now
		a.quickScanLastStage = p.Stage
	}
	// 里程碑只升不降：逐候选回调里 99% 的调用都返回同一档，
	// 只有真的跨过 25 / 50 / 75 才返回新值 → 气泡不会刷屏。
	milestone := quickScanMilestone(overall)
	newMilestone := 0
	if milestone > a.quickScanMilestone {
		newMilestone = milestone
		a.quickScanMilestone = milestone
	}
	a.qsMu.Unlock()

	if titleDue {
		title := quickScanTitle(p)
		a.mQuickScan.SetTitle(title)
		a.mQuickScan.SetTooltip(quickScanTooltip(p))
		systray.SetTooltip(quickScanTooltip(p))
	}
	if newMilestone > 0 {
		a.showBalloonQuiet(
			fmt.Sprintf("CFPilot 优选 %d%%", newMilestone),
			fmt.Sprintf("已完成约 %d%%：%s", newMilestone, quickScanStageLabel(p.Stage)),
		)
	}
}

// FinishQuickScan 在扫描结束（成功 / 失败 / 互相抢占失败）后恢复菜单状态，
// 并弹一条完成气泡。
//
// ⚠️ 调用方必须保证**一定调用**（成功、失败、panic 恢复都要走到）：
// 否则父项永远停在进度标题、账号项永远灰着，用户只能重启程序。
func (a *App) FinishQuickScan(res server.QuickScanResult) {
	a.qsMu.Lock()
	wasRunning := a.quickScanRunning
	a.quickScanRunning = false
	a.quickScanMilestone = 0
	a.quickScanLastStage = ""
	a.quickScanLastTitleAt = time.Time{}
	if wasRunning {
		a.setQuickScanSlotsEnabledLocked(true)
	}
	a.qsMu.Unlock()
	if !wasRunning {
		// 重复调用只处理一次（例如实现自己调了 Finish，托盘兜底又调一次）
		return
	}

	// 恢复父项标题（「一键优选 IP」/「一键优选 IP（暂无账号）」）与账号勾选
	a.refreshQuickScanMenu()
	systray.SetTooltip(trayTooltipIdle)

	if res.OK {
		a.showBalloonQuiet("CFPilot 优选完成", res.Message)
		return
	}
	a.showBalloonQuiet("CFPilot 优选失败", res.Error+"\n（详情见界面「日志」页）")
}

// refreshQuickScanMenu 按凭据库里的账号列表刷新「一键优选 IP」子菜单。
//
// 每 10 秒的定时刷新会走到这里，所以必须**差量更新**：
// 只有期望状态与上次应用的状态不同才动菜单项（否则菜单开着时会跳动，
// 而且 Windows 上对隐藏项的任何 update 都会把它重新插回菜单）。
func (a *App) refreshQuickScanMenu() {
	if a.mQuickScan == nil || a.srv == nil || len(a.mQuickScanSlots) == 0 {
		return
	}

	a.qsMu.Lock()
	defer a.qsMu.Unlock()

	// 运行中：标题由进度回调维护，账号项保持置灰，不做任何重排
	if a.quickScanRunning {
		return
	}

	plan := planQuickScanAccounts(a.srv.QuickScanAccounts(), len(a.mQuickScanSlots))
	a.applyQuickScanPlanLocked(plan)
	a.setQuickScanSlotsEnabledLocked(true)

	// 父项：一个账号都没有时置灰（用户明确要求「没有账号则该菜单变灰」）
	if plan.Total == 0 {
		a.mQuickScan.Disable()
		a.mQuickScan.SetTitle(quickScanTitleIdle(0))
		a.mQuickScan.SetTooltip("还没有保存账号，请先在界面「凭据」页添加")
		return
	}
	// 有账号时必须 Enable：Windows 上**置灰的菜单项不会展开子菜单**，
	// 而父项的唯一作用就是展开账号列表（点击它本身不执行任何操作）。
	a.mQuickScan.Enable()
	a.mQuickScan.SetTitle(quickScanTitleIdle(plan.Total))
	a.mQuickScan.SetTooltip(fmt.Sprintf("选择账号执行一键优选（共 %d 个账号）", plan.Total))
}

// applyQuickScanPlanLocked 把账号子菜单的期望状态差量应用到槽位池。
//
// ⚠️ 调用方必须持有 qsMu。
// ⚠️ 隐藏槽位只 Hide，**绝不**调 SetTitle / Check / Enable / Disable：
// systray 的每次 update() 都会走 addOrUpdateMenuItem，而 Windows 实现
// 对「不在 visibleItems 里的项」会重新 InsertMenuItem —— 隐藏的空槽位
// 会被这些调用变成一行可见的空白菜单项（见 diffQuickScanSlot）。
func (a *App) applyQuickScanPlanLocked(plan quickScanAccountPlan) {
	for i, item := range a.mQuickScanSlots {
		var want, have quickScanAccountSlot
		if i < len(plan.Slots) {
			want = plan.Slots[i]
		}
		if i < len(a.qsApplied.Slots) {
			have = a.qsApplied.Slots[i]
		}
		d := diffQuickScanSlot(want, have)
		if d.Hide {
			item.Hide()
			continue
		}
		// 顺序：先改标题 / 勾选，最后 Show —— 反过来会先闪一行旧的占位文字。
		if d.Title != "" {
			item.SetTitle(d.Title)
		}
		if d.Checked != nil {
			if *d.Checked {
				item.Check()
			} else {
				item.Uncheck()
			}
		}
		if d.Show {
			item.Show()
		}
	}

	// 「更多账号请在界面操作」兜底提示项
	if a.mQuickScanMore != nil {
		switch {
		case plan.MoreVisible:
			if plan.MoreTitle != a.qsApplied.MoreTitle {
				a.mQuickScanMore.SetTitle(plan.MoreTitle)
			}
			if !a.qsApplied.MoreVisible {
				a.mQuickScanMore.Show()
			}
		case a.qsApplied.MoreVisible:
			a.mQuickScanMore.Hide()
		}
	}

	a.qsApplied = plan
}

// setQuickScanSlotsEnabledLocked 批量启用 / 置灰**当前可见**的账号槽位。
//
// ⚠️ 调用方必须持有 qsMu。
// ⚠️ 不能对隐藏槽位调 Enable/Disable：systray 的 update() 会把隐藏项
// 重新插回菜单（Windows 上 addOrUpdateMenuItem 对不可见项会重新
// InsertMenuItem）—— 隐藏的槽位会被「顺手禁用一下」变成可见空白行。
func (a *App) setQuickScanSlotsEnabledLocked(enabled bool) {
	if a.quickScanSlotsDisabled == !enabled {
		return // 已经是目标状态，避免每 10 秒重复打 Win32 调用
	}
	for i, item := range a.mQuickScanSlots {
		if i >= len(a.qsApplied.Slots) || !a.qsApplied.Slots[i].Visible {
			continue
		}
		if enabled {
			item.Enable()
		} else {
			item.Disable()
		}
	}
	a.quickScanSlotsDisabled = !enabled
}

// showBalloonQuiet 弹一条托盘气泡；失败只记日志。
//
// 气泡被系统通知策略禁用 / 托盘窗口还没建好时不该影响主流程 ——
// 进度本身在菜单标题上，气泡只是补充。
func (a *App) showBalloonQuiet(title, body string) {
	if err := a.ShowBalloon(title, body, 6*time.Second); err != nil {
		log.Printf("[cfpilot] 气泡通知未能显示：%v（%s：%s）", err, title, body)
	}
}

// ---------- 一键优选：纯逻辑（单测覆盖，不碰 systray） ----------

// quickScanAccountSlot 是账号槽位池里一个槽位应有的状态。
type quickScanAccountSlot struct {
	// Visible 表示该槽位在菜单里可见
	Visible bool
	// Title 是菜单项标题（<账号名> · <账号ID前8位>）
	Title string
	// Checked 表示当前活跃账号（菜单项前面打勾）
	Checked bool
	// ID 是槽位对应的账号 ID（点击时回传给 main，跑该账号的优选）
	ID string
}

// quickScanAccountPlan 是「一键优选 IP」子菜单的完整期望状态。
type quickScanAccountPlan struct {
	// Slots 与固定槽位池一一对应（长度 = 槽位池大小）
	Slots []quickScanAccountSlot
	// MoreVisible / MoreTitle 是「更多账号请在界面操作」兜底项
	MoreVisible bool
	MoreTitle   string
	// Total 是账号总数（可能大于槽位池容量）
	Total int
}

// quickScanSlotDiff 描述一个槽位需要做哪些菜单更新（纯数据，便于单测）。
type quickScanSlotDiff struct {
	// Title 非空表示要 SetTitle
	Title string
	// Checked 非 nil 表示要 Check / Uncheck
	Checked *bool
	// Show / Hide 表示可见性变化
	Show bool
	Hide bool
}

// planQuickScanAccounts 把账号列表映射到固定槽位池的期望状态。
//
// 纯函数：不碰 systray、不做 IO，便于单测槽位映射与标题。
// 槽位顺序 = 凭据库顺序，超出 poolSize 的账号不进菜单（由 MoreTitle 提示去界面操作）。
func planQuickScanAccounts(accounts []server.QuickScanAccount, poolSize int) quickScanAccountPlan {
	if poolSize < 0 {
		poolSize = 0
	}
	plan := quickScanAccountPlan{
		Slots: make([]quickScanAccountSlot, poolSize),
		Total: len(accounts),
	}
	visible := len(accounts)
	if visible > poolSize {
		visible = poolSize
	}
	for i := 0; i < visible; i++ {
		a := accounts[i]
		plan.Slots[i] = quickScanAccountSlot{
			Visible: true,
			Title:   accountLabel(a.Name, a.AccountID, a.ID),
			Checked: a.Active,
			ID:      a.ID,
		}
	}
	if len(accounts) > poolSize {
		plan.MoreVisible = true
		plan.MoreTitle = fmt.Sprintf("更多账号（共 %d 个）请在界面操作", len(accounts))
	}
	return plan
}

// diffQuickScanSlot 比较槽位的期望状态与已应用状态，得出最小更新集合。
//
// 纯函数。两条关键约束：
//  1. 期望隐藏时**只 Hide**，不产生任何会触发 systray update() 的操作 ——
//     Windows 上 SetTitle / Enable / Check 都会把隐藏项重新插回菜单；
//  2. 新出现的账号：先改标题 / 勾选，最后 Show（顺序反了会先闪一行占位文字）。
func diffQuickScanSlot(want, have quickScanAccountSlot) quickScanSlotDiff {
	var d quickScanSlotDiff
	if !want.Visible {
		d.Hide = have.Visible
		return d
	}
	if want.Title != have.Title {
		d.Title = want.Title
	}
	if want.Checked != have.Checked {
		checked := want.Checked
		d.Checked = &checked
	}
	d.Show = !have.Visible
	return d
}

// quickScanTitleIdle 是「一键优选 IP」父项的常态标题。
func quickScanTitleIdle(accountCount int) string {
	if accountCount <= 0 {
		return "一键优选 IP（暂无账号）"
	}
	return "一键优选 IP"
}

// accountLabel 生成账号项的展示标题：<账号名> · <账号ID前8位>。
//
// 细节：
//   - 账号名为空时用「账户」；
//   - 账号 ID 为空时用凭据库的 profile ID 兜底（保证菜单项之间能区分）；
//   - 名字里**已经含**这个 8 位前缀时不再重复拼接 ——
//     凭据库自动推导的名字本身就是「账户 <账号ID前8位>」，
//     硬拼会变成「账户 abc12345 · abc12345」。
func accountLabel(name, accountID, profileID string) string {
	label := strings.TrimSpace(name)
	short := strings.TrimSpace(accountID)
	if short == "" {
		short = strings.TrimSpace(profileID)
	}
	if len(short) > 8 {
		short = short[:8]
	}
	if label == "" {
		label = "账户"
	}
	if short == "" || strings.Contains(label, short) {
		return label
	}
	return label + " · " + short
}

// progressPercent 算「当前阶段」的百分比。
//
// total <= 0 时返回 0；done 允许越界（下界清零、上界钳到 total），
// 因为收尾事件偶尔会给出 done=total+1 之类。
func progressPercent(done, total int) int {
	if total <= 0 {
		return 0
	}
	return clampInt(done, 0, total) * 100 / total
}

// clampInt 把 v 钳到 [lo, hi]。
func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// quickScanStageLabel 把扫描阶段转成菜单里用的短中文名。
//
// 标题要短（菜单宽度有限），所以不用 scan.Progress.Message 里的长句
// （「阶段一：TCP 握手初筛」）。
func quickScanStageLabel(stage string) string {
	switch stage {
	case "prepare":
		return "读取清单"
	case "tcp":
		return "扫描"
	case "tls":
		return "TLS 握手"
	case "probe":
		return "WS 校验"
	case "speed":
		return "测速"
	case "push":
		return "回填"
	default:
		return "进行中"
	}
}

// quickScanTitle 生成运行中的父项标题，如「一键优选：扫描 45/1500 · 3%」。
func quickScanTitle(p scan.Progress) string {
	stage := quickScanStageLabel(p.Stage)
	if p.Total <= 0 {
		return "一键优选：" + stage + "…"
	}
	return fmt.Sprintf("一键优选：%s %d/%d · %d%%",
		stage, clampInt(p.Done, 0, p.Total), p.Total, progressPercent(p.Done, p.Total))
}

// quickScanTooltip 是运行中父项 / 托盘图标的 tooltip 内容。
func quickScanTooltip(p scan.Progress) string {
	msg := p.Message
	if msg == "" {
		msg = quickScanStageLabel(p.Stage)
	}
	if p.Total <= 0 {
		return msg
	}
	return fmt.Sprintf("%s（%d/%d，%d%%）",
		msg, clampInt(p.Done, 0, p.Total), p.Total, progressPercent(p.Done, p.Total))
}

// quickScanOverallRange 是某个扫描阶段在「整体进度」里占的区间。
type quickScanOverallRange struct {
	Start int
	Span  int
}

// quickScanOverallRanges 把各阶段映射到整体进度区间。
//
// ## 为什么需要「整体进度」
//
// 里程碑气泡（25% / 50% / 75%）必须**全局只弹一次**。若直接用当前阶段的
// 百分比，三个扫描阶段会各弹三轮（共 9 条气泡），纯属刷屏 ——
// 而用户真正想知道的是「大概到哪了」。
//
// 权重按一键优选各阶段的相对耗时估的（真机约 1~3 分钟）：
//
//	tcp   0~60%   （1500 个候选，最慢，通常占一半以上时间）
//	tls  60~85%   （约 1/5 候选能进 TLS 握手）
//	probe 85~95%  （约 120 个候选进 WS 101 校验）
//	push  95~99%  （回填面板，几秒）
//
// 只需保证**单调不减**，不需要精确 —— 它只用来触发里程碑。
var quickScanOverallRanges = map[string]quickScanOverallRange{
	"tcp":   {Start: 0, Span: 60},
	"tls":   {Start: 60, Span: 25},
	"probe": {Start: 85, Span: 10},
	"speed": {Start: 95, Span: 4},
	"push":  {Start: 95, Span: 4},
}

// overallPercent 把「当前阶段进度」换算成整体进度（0~100）。
//
// 未知阶段（含 prepare）返回 0 —— 不参与里程碑，避免开跑就误报。
func overallPercent(stage string, done, total int) int {
	r, ok := quickScanOverallRanges[stage]
	if !ok {
		return 0
	}
	return r.Start + r.Span*progressPercent(done, total)/100
}

// quickScanMilestone 返回当前整体进度**已经跨过**的最高里程碑（0/25/50/75）。
//
// 纯函数：托盘只记住上次弹到哪一档，值不变就不弹 —— 这是里程碑气泡
// 不刷屏的关键（逐候选回调里 99% 的调用都返回同一档）。
func quickScanMilestone(percent int) int {
	switch {
	case percent >= 75:
		return 75
	case percent >= 50:
		return 50
	case percent >= 25:
		return 25
	default:
		return 0
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
