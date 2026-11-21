//go:build windows

package shell

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

// Windows 消息与样式常量。
//
// 数值取自 WinUser.h；这里只列本包真正用到的部分，
// 常量名与头文件一致，便于对照。
const (
	wmClose          = 0x0010
	wmGetMinMaxInfo  = 0x0024
	wmNCLButtonDown  = 0x00A1
	wmAppActivate    = 0x8000 + 1 // 自定义：另一个实例请求唤醒窗口

	// MONITOR_DEFAULTTONEAREST：取离窗口最近的显示器（多显示器 + 负坐标场景必需）。
	monitorDefaultToNearest = 0x00000002

	htCaption = 2

	gwlpWndProc int32 = -4
	gwlStyle    int32 = -16

	wsCaption     = 0x00C00000
	wsThickFrame  = 0x00040000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsMaximizeBox = 0x00010000

	swHide     = 0
	swShow     = 5
	swMinimize = 6
	swMaximize = 3
	swRestore  = 9

	swpNoSize      = 0x0001
	swpNoMove      = 0x0002
	swpNoZOrder    = 0x0004
	swpFrameChange = 0x0020

	dwmwaWindowCornerPreference = 33
	dwmcpRound                  = 2
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	dwmapi = windows.NewLazySystemDLL("dwmapi.dll")

	procSetWindowLongPtrW     = user32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtrW     = user32.NewProc("GetWindowLongPtrW")
	procCallWindowProcW       = user32.NewProc("CallWindowProcW")
	procShowWindow            = user32.NewProc("ShowWindow")
	procIsZoomed              = user32.NewProc("IsZoomed")
	procIsIconic              = user32.NewProc("IsIconic")
	procFindWindowW           = user32.NewProc("FindWindowW")
	procPostMessageW          = user32.NewProc("PostMessageW")
	procSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
	procSetWindowPos          = user32.NewProc("SetWindowPos")
	procReleaseCapture        = user32.NewProc("ReleaseCapture")
	procSendMessageW          = user32.NewProc("SendMessageW")
	procMonitorFromWindow     = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW       = user32.NewProc("GetMonitorInfoW")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

// 下面几个结构与 WinUser.h 的布局逐字段对应，只用于 WM_GETMINMAXINFO。
//
// 为什么必须要它：webview2 建窗时用的是 WS_OVERLAPPEDWINDOW，
// 而本包 makeBorderless 去掉了 WS_CAPTION（无边框自绘标题栏）。
// 系统默认按「整屏」算最大化尺寸，于是窗口盖住任务栏 —— 用户报的就是这个。
// 收到 WM_GETMINMAXINFO 时把最大化尺寸改成本机工作区（减去任务栏）
// 即可正常最大化，不动其它窗口样式。
type winPoint struct {
	X, Y int32
}

type winRect struct {
	Left, Top, Right, Bottom int32
}

type winMinMaxInfo struct {
	PtReserved     winPoint
	PtMaxSize      winPoint
	PtMaxPosition  winPoint
	PtMinTrackSize winPoint
	PtMaxTrackSize winPoint
}

type winMonitorInfo struct {
	CbSize    uint32
	RcMonitor winRect
	RcWork    winRect
	DwFlags   uint32
}

// maximizedBounds 由显示器矩形与工作区矩形算出最大化窗口的位置与大小。
//
// 多显示器下 RcWork 可能是负数坐标（主屏在右边时，左屏 x < 0），
// 所以位置要减去显示器原点、而不是直接写工作区坐标。
// 工作区本身就是「屏幕去掉任务栏」的区域，这样最大化就不会遮挡任务栏。
func maximizedBounds(monitor, work winRect) (pos, size winPoint) {
	pos = winPoint{X: work.Left - monitor.Left, Y: work.Top - monitor.Top}
	size = winPoint{X: work.Right - work.Left, Y: work.Bottom - work.Top}
	return pos, size
}

// applyWorkAreaMaximized 从系统拿当前显示器工作区，写回 MINMAXINFO。
//
// 任何一步失败都直接返回、保留系统默认值（fail-open）：
// 最坏是退回旧的「盖住任务栏」行为，而不是让最大化彻底失效。
func applyWorkAreaMaximized(hwnd uintptr, mmi *winMinMaxInfo) {
	if mmi == nil {
		return
	}
	hmon, _, _ := procMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	if hmon == 0 {
		return
	}
	var mi winMonitorInfo
	mi.CbSize = uint32(unsafe.Sizeof(mi))
	r, _, _ := procGetMonitorInfoW.Call(hmon, uintptr(unsafe.Pointer(&mi)))
	if r == 0 {
		return
	}
	pos, size := maximizedBounds(mi.RcMonitor, mi.RcWork)
	if size.X <= 0 || size.Y <= 0 {
		return
	}
	mmi.PtMaxPosition = pos
	mmi.PtMaxSize = size
	mmi.PtMaxTrackSize = size
}

// panel 是 Windows 上的实现。
//
// 线程模型：
//   - **创建与消息循环必须在同一个锁定线程上**（WebView2 的 COM 对象
//     绑在创建线程上）。所以 New 起一个 LockOSThread 的 goroutine，
//     在那里创建窗口并跑 Run；
//   - 之后的 Show / Hide 通过 wv.Dispatch 回到那个线程执行；
//   - 主程序（托盘消息循环）仍在主 goroutine，互不占用。
type panel struct {
	opts Options

	mu    sync.Mutex
	wv    webview2.WebView
	hwnd  uintptr
	shown bool
	dead  bool

	done chan struct{}

	// 子类化 WndProc 需要保存原过程地址；回调地址由 NewCallback 分配，
	// 必须留引用防止被 GC 回收（否则消息一到就崩）。
	origWndProc uintptr
	wndProc     uintptr
}

// New 创建面板窗口；成功时窗口已经可见并开始加载面板。
//
// 返回 ErrAlreadyRunning 表示同机已有面板窗口（已把它唤醒）；
// 返回 ErrUnsupported 表示 WebView2 运行时不可用。
func New(opts Options) (Panel, error) {
	if opts.URL == "" {
		return nil, errors.New("缺少面板地址")
	}
	if opts.URL[0] != 'h' || len(opts.URL) < 8 || opts.URL[:7] != "http://" {
		return nil, fmt.Errorf("面板地址必须是回环 http 地址：%q", opts.URL)
	}
	if opts.Title == "" {
		opts.Title = "CFPilot 部署与网络维护"
	}
	if opts.Width <= 0 {
		opts.Width = 1180
	}
	if opts.Height <= 0 {
		opts.Height = 820
	}

	// 单实例：已有窗口就唤醒它，本进程安静退出。
	if hwnd := findWindow(opts.Title); hwnd != 0 {
		procPostMessageW.Call(hwnd, wmAppActivate, 0, 0)
		return nil, ErrAlreadyRunning
	}

	p := &panel{opts: opts, done: make(chan struct{})}
	ready := make(chan error, 1)
	go p.loop(ready)

	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
		return p, nil
	case <-time.After(20 * time.Second):
		// 创建卡住时不要无限等：回退浏览器，至少能用。
		return nil, errors.New("内嵌窗口初始化超时")
	}
}

func (p *panel) loop(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(p.done)

	// WebView2 的数据目录放配置目录下的私有子目录：
	// Cookie 与会话都落在这里，不能让同机其它用户读。
	dataPath := p.opts.DataDir
	if dataPath != "" {
		_ = os.MkdirAll(dataPath, 0o700)
	}

	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  dataPath,
		WindowOptions: webview2.WindowOptions{
			Title:  p.opts.Title,
			Width:  uint(p.opts.Width),
			Height: uint(p.opts.Height),
			Center: true,
		},
	})
	if wv == nil {
		ready <- fmt.Errorf("%w：未能创建 WebView2 窗口（通常是缺少 Edge WebView2 运行时）", ErrUnsupported)
		return
	}

	hwnd := uintptr(wv.Window())
	if hwnd == 0 {
		wv.Destroy()
		ready <- fmt.Errorf("%w：窗口句柄无效", ErrUnsupported)
		return
	}

	// 无边框：去掉标题栏，保留粗边框 ——
	// 粗边框同时提供 DWM 阴影、边缘缩放与最大化贴靠，比自绘命中测试可靠。
	if !makeBorderless(hwnd) {
		p.opts.logf("[shell] 无边框样式设置失败，改用系统标题栏")
	}
	roundCorners(hwnd)
	installWndProc(p, hwnd)

	_ = wv.Bind("cfpilotShellCommand", p.handleCommand)
	wv.Init(InitScript("windows", ChromeCustom))
	wv.Navigate(p.opts.URL)

	p.mu.Lock()
	p.wv = wv
	p.hwnd = hwnd
	p.shown = true
	p.mu.Unlock()

	ready <- nil

	wv.Run()

	p.mu.Lock()
	p.dead = true
	p.mu.Unlock()
	wv.Destroy()
}

func (p *panel) Platform() string { return "windows" }

func (p *panel) Chrome() ChromeMode { return ChromeCustom }

func (p *panel) Wait() { <-p.done }

// closeWait 是 Close() 等待 WebView 线程退出的最长时间。
//
// ⚠️ 必须有限：退出动作不能因为窗口线程卡死而永远阻塞
// （用户报过「点托盘退出没反应、只能强制杀进程」）。
const closeWait = 1500 * time.Millisecond

func (p *panel) Close() {
	p.mu.Lock()
	wv := p.wv
	dead := p.dead
	p.mu.Unlock()
	if wv == nil || dead {
		return
	}

	// ⚠️ webview2 的 Terminate() 内部是 PostQuitMessage —— 它把 WM_QUIT
	// 投到**调用线程**的消息队列，而 wv.Run() 跑在另一个 LockOSThread 的线程上。
	// 从托盘线程直接调 Terminate()，Run() 永远收不到 WM_QUIT，
	// 下面的 <-p.done 就死锁 —— 这正是「退出无反应、程序假死」的根因。
	// 必须 Dispatch 到 WebView 自己的线程再 Terminate。
	wv.Dispatch(wv.Terminate)

	// 超时兜底：WebView 线程万一卡在 COM 调用里，退出也不能被拖住。
	select {
	case <-p.done:
	case <-time.After(closeWait):
		p.opts.logf("[shell] 等待面板窗口退出超时，继续退出流程")
	}
}

// Show 显示并置前窗口，可选切换到某个页签。
func (p *panel) Show(page string) bool {
	p.mu.Lock()
	wv := p.wv
	dead := p.dead
	p.mu.Unlock()
	if wv == nil || dead {
		return false
	}
	page = sanitizePage(page)
	wv.Dispatch(func() {
		p.showWindow()
		if page != "" {
			wv.Eval(pageScript(page))
		}
	})
	return true
}

func (p *panel) Hide() {
	p.mu.Lock()
	wv := p.wv
	dead := p.dead
	p.mu.Unlock()
	if wv == nil || dead {
		return
	}
	wv.Dispatch(func() { p.hideWindow() })
}

func (p *panel) showWindow() {
	p.mu.Lock()
	hwnd := p.hwnd
	p.mu.Unlock()
	if hwnd == 0 {
		return
	}
	// 只有「最小化」才需要先还原；对最大化窗口调 SW_RESTORE 会把它缩回普通尺寸。
	if r, _, _ := procIsIconic.Call(hwnd); r != 0 {
		procShowWindow.Call(hwnd, swRestore)
	}
	procShowWindow.Call(hwnd, swShow)
	procSetForegroundWindow.Call(hwnd)
	p.mu.Lock()
	p.shown = true
	p.mu.Unlock()
}

func (p *panel) hideWindow() {
	p.mu.Lock()
	hwnd := p.hwnd
	p.mu.Unlock()
	if hwnd == 0 {
		return
	}
	procShowWindow.Call(hwnd, swHide)
	p.mu.Lock()
	p.shown = false
	p.mu.Unlock()
}

// handleCommand 是 JS 桥的入口。
//
// 参数是 JSON 数组里的第一个元素（一个 JSON 字符串），
// 由 InitScript 注入的 cfpilotShellCommand 传入。
func (p *panel) handleCommand(raw string) string {
	c, err := decodeCommand(raw)
	if err != nil {
		p.opts.logf("[shell] 忽略非法命令：%v", err)
		return ""
	}
	p.mu.Lock()
	wv := p.wv
	dead := p.dead
	hwnd := p.hwnd
	p.mu.Unlock()

	switch c.Cmd {
	case CmdDrag:
		if wv != nil && !dead {
			wv.Dispatch(func() {
				// 拖动必须由窗口线程发：先把鼠标捕获交回系统，
				// 再假装按住标题栏 —— 由系统完成移动 / 贴靠。
				procReleaseCapture.Call()
				procSendMessageW.Call(hwnd, wmNCLButtonDown, htCaption, 0)
			})
		}
	case CmdMin:
		procShowWindow.Call(hwnd, swMinimize)
	case CmdMax:
		if r, _, _ := procIsZoomed.Call(hwnd); r != 0 {
			procShowWindow.Call(hwnd, swRestore)
		} else {
			procShowWindow.Call(hwnd, swMaximize)
		}
	case CmdClose:
		p.Hide()
	case CmdOpenExternal:
		if !externalAllowed(c.URL) {
			p.opts.logf("[shell] 拒绝打开非 https 链接")
			return ""
		}
		if p.opts.OpenExternal != nil {
			if err := p.opts.OpenExternal(c.URL); err != nil {
				p.opts.logf("[shell] 打开外部链接失败：%v", err)
			}
		}
	default:
		p.opts.logf("[shell] 未知命令：%q", c.Cmd)
	}
	return ""
}

// ActivateExisting 查找同机已存在的面板窗口并把它唤醒。
//
// 用途：上一个实例还在托盘里跑时，用户再双击一次 exe，
// 真正想要的是「把面板调出来」；此时新进程会先因为端口被占用而启动失败，
// 主程序据此调用本函数，把窗口拉回前台并安静退出。
// 返回 true 表示已唤醒（调用方不要再报错，也不要再启动第二个服务）。
func ActivateExisting(title string) bool {
	if title == "" {
		return false
	}
	hwnd := findWindow(title)
	if hwnd == 0 {
		return false
	}
	procPostMessageW.Call(hwnd, wmAppActivate, 0, 0)
	return true
}

// findWindow 按标题查找已有窗口（单实例唤醒用）。
func findWindow(title string) uintptr {
	ptr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return 0
	}
	r, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(ptr)))
	return r
}

// makeBorderless 去掉标题栏但保留粗边框。
func makeBorderless(hwnd uintptr) bool {
	style := getWindowLongPtr(hwnd, gwlStyle)
	next := style &^ wsCaption
	// 粗边框 / 菜单 / 最小化 / 最大化都要留着：
	// 阴影、边缘缩放、任务栏系统菜单、最大化贴靠都依赖它们。
	next |= wsThickFrame | wsSysMenu | wsMinimizeBox | wsMaximizeBox
	if next == style {
		return true
	}
	prev, _, err := procSetWindowLongPtrW.Call(hwnd, longPtrIndex(gwlStyle), next)
	if prev == 0 && err != nil && err != windows.ERROR_SUCCESS {
		return false
	}
	procSetWindowPos.Call(
		hwnd, 0, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoZOrder|swpFrameChange,
	)
	return true
}

// longPtrIndex 把负的窗口属性索引转成 syscall 需要的无符号值。
//
// 常量 -16 直接转 uintptr 会编译报错（常量溢出）；
// 先存进变量再转，得到的是运行时的二进制补码，正是 Win32 期望的值。
func longPtrIndex(index int32) uintptr {
	v := index
	return uintptr(v)
}

// getWindowLongPtr 读取窗口样式（索引是负数，必须经变量转换）。
func getWindowLongPtr(hwnd uintptr, index int32) uintptr {
	idx := uintptr(index)
	r, _, _ := procGetWindowLongPtrW.Call(hwnd, idx)
	return r
}

// roundCorners 在 Windows 11 上使用系统圆角；旧系统忽略失败。
func roundCorners(hwnd uintptr) {
	pref := int32(dwmcpRound)
	procDwmSetWindowAttribute.Call(
		hwnd,
		dwmwaWindowCornerPreference,
		uintptr(unsafe.Pointer(&pref)),
		unsafe.Sizeof(pref),
	)
}

// installWndProc 子类化父窗口过程：
//   - 关闭按钮改成「隐藏」，服务与后台任务继续跑；
//   - 其它实例请求唤醒时把窗口显示出来。
func installWndProc(p *panel, hwnd uintptr) {
	orig, _, _ := procSetWindowLongPtrW.Call(hwnd, longPtrIndex(gwlpWndProc), 0)
	if orig == 0 {
		p.opts.logf("[shell] 无法读取原窗口过程，关闭按钮将直接退出窗口")
		return
	}
	cb := windows.NewCallback(func(h, msg, wp, lp uintptr) uintptr {
		switch msg {
		case wmClose:
			p.hideWindow()
			return 0
		case wmAppActivate:
			p.showWindow()
			return 0
		case wmGetMinMaxInfo:
			// 先让 webview2 的原过程处理（它会写 minsz 等），再把最大化
			// 尺寸限制到当前显示器的「工作区」——即扣掉任务栏的区域。
			// 这样无边框窗口最大化就只铺满工作区，不遮挡任务栏。
			r, _, _ := procCallWindowProcW.Call(orig, h, msg, wp, lp)
			if lp != 0 {
				applyWorkAreaMaximized(h, (*winMinMaxInfo)(unsafe.Pointer(lp)))
			}
			return r
		}
		r, _, _ := procCallWindowProcW.Call(orig, h, msg, wp, lp)
		return r
	})
	if r, _, err := procSetWindowLongPtrW.Call(hwnd, longPtrIndex(gwlpWndProc), cb); r == 0 && err != nil && err != windows.ERROR_SUCCESS {
		p.opts.logf("[shell] 子类化窗口过程失败：%v", err)
		return
	}
	p.mu.Lock()
	p.origWndProc = orig
	p.wndProc = cb
	p.mu.Unlock()
}
