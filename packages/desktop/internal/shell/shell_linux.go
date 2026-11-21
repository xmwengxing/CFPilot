//go:build linux && cfp_gui

package shell

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/crgimenes/glaze"
)

// panel 是 Linux 上的实现。
//
// 后端是系统 WebKitGTK（GTK3 + webkit2gtk-4.x 或 GTK4 + webkitgtk-6.0），
// 由 glaze 在运行时 dlopen，**不链接 webkit 本身**。
//
// ⚠️ 但这个后端只在 `cfp_gui` 构建标签下编入：
// glaze 依赖的 purego 会通过 //go:cgo_import_dynamic 调 dlopen，
// 链接结果因此带上 glibc 的 DT_NEEDED（libc.so.6 / libdl / libpthread）。
// 容器镜像是 Alpine（musl），带这种产物的二进制根本起不来 ——
// 所以容器用的静默产物**不带本标签**，见 shell_linux_headless.go。
//
// 标题栏：GTK 的窗口装饰由窗口管理器绘制，本包不自绘 ——
// 面板会根据 Chrome() 的返回值隐藏 HTML 标题栏，避免两层标题。
type panel struct {
	opts Options

	mu     sync.Mutex
	wv     glaze.WebView
	dead   bool
	closed bool

	done chan struct{}
}

// New 创建 Linux 面板窗口。
//
// 没有图形会话、或系统缺少 WebKitGTK 时返回 ErrUnsupported，
// 调用方回退到系统浏览器。
func New(opts Options) (Panel, error) {
	if opts.URL == "" {
		return nil, errors.New("缺少面板地址")
	}
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return nil, fmt.Errorf("%w：没有图形会话（DISPLAY / WAYLAND_DISPLAY 均为空）", ErrUnsupported)
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
		return nil, errors.New("内嵌窗口初始化超时")
	}
}

func (p *panel) loop(ready chan<- error) {
	// GTK 要求主线程（这里是锁定后的 goroutine 线程）创建窗口并跑主循环。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(p.done)

	// glaze 初始化会 dlopen libwebkitgtk / libwebkit2gtk 与 libgtk；
	// 缺库时返回 error，这里转成 ErrUnsupported 交给调用方回退。
	wv, err := glaze.NewWithOptions(glaze.Options{
		Debug: false,
		OnClose: func() {
			p.mu.Lock()
			p.closed = true
			p.mu.Unlock()
			p.opts.logf("[shell] 面板窗口已关闭（服务继续在托盘运行）")
		},
	})
	if err != nil {
		ready <- fmt.Errorf("%w：%v", ErrUnsupported, err)
		return
	}

	wv.SetTitle(p.opts.Title)
	wv.SetSize(p.opts.Width, p.opts.Height, glaze.HintNone)
	_ = wv.Bind("cfpilotShellCommand", p.handleCommand)
	wv.Init(InitScript("linux", ChromeNative))
	wv.Navigate(p.opts.URL)

	p.mu.Lock()
	p.wv = wv
	p.mu.Unlock()

	ready <- nil

	// 启动失败（例如 dlopen 成功但 GTK 初始化不了）时不要 panic 掉整个进程。
	func() {
		defer func() {
			if r := recover(); r != nil {
				p.opts.logf("[shell] 窗口循环异常：%v", r)
			}
		}()
		wv.Run()
	}()

	p.mu.Lock()
	p.dead = true
	p.mu.Unlock()
	wv.Destroy()
}

// ActivateExisting 在 Linux 上不支持查找既有窗口。
//
// glaze 没有暴露「按标题找窗口」的能力，而托盘里已经有一个「打开面板」入口，
// 这里返回 false 即可（调用方按端口占用报错处理）。
func ActivateExisting(string) bool { return false }

func (p *panel) Platform() string { return "linux" }

func (p *panel) Chrome() ChromeMode { return ChromeNative }

func (p *panel) Wait() { <-p.done }

func (p *panel) Close() {
	p.mu.Lock()
	wv := p.wv
	dead := p.dead
	p.mu.Unlock()
	if wv == nil || dead {
		return
	}
	wv.Terminate()
	// 与 Windows 版同口径：退出动作不能被 GTK 主循环的异常卡死
	// （托盘点退出后整进程假死，用户只能 kill -9）。
	select {
	case <-p.done:
	case <-time.After(1500 * time.Millisecond):
		p.opts.logf("[shell] 等待面板窗口退出超时，继续退出流程")
	}
}

// Show 在 Linux 上只能在窗口还活着时置前。
//
// GTK 窗口一旦被用户关掉就销毁了，无法像 Windows 那样隐藏后复用。
// 这时返回 false，调用方回退到系统浏览器 —— 界面仍然可用，
// 只是换成了浏览器标签页（与早前版本一致）。
func (p *panel) Show(page string) bool {
	p.mu.Lock()
	wv := p.wv
	dead := p.dead
	closed := p.closed
	p.mu.Unlock()
	if wv == nil || dead || closed {
		return false
	}
	page = sanitizePage(page)
	if page != "" {
		wv.Eval(pageScript(page))
	}
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
	// GTK 没有「隐藏并保留」的语义，等价于关闭窗口（服务继续跑）。
	wv.Terminate()
}

func (p *panel) handleCommand(raw string) string {
	c, err := decodeCommand(raw)
	if err != nil {
		p.opts.logf("[shell] 忽略非法命令：%v", err)
		return ""
	}
	switch c.Cmd {
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
	case CmdClose:
		p.Hide()
	default:
		// 拖动 / 最小化 / 最大化由窗口管理器接管，不需要桥。
	}
	return ""
}
