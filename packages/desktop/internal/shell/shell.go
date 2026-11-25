// Package shell 承载 CFPilot 桌面版的**独立面板窗口**。
//
// ## 为什么需要它
//
// 早前桌面版的界面开在系统浏览器标签页里：托盘点了「打开业务界面」，
// 系统浏览器多出一个标签，地址栏里还带着启动令牌。用户看到的是
// 「一个网页」，而不是一个桌面应用；关掉标签页后也分不清服务还在不在。
//
// 本包把面板装进应用自己的窗口：无地址栏、无标签页、关窗即收进托盘。
//
// ## 为什么不用框架
//
// 面板本身是 8000 行 HTML/JS + 60 多个本地 HTTP 路由，重写成原生控件
// 等于重做一个产品；而 Electron 那种「自带浏览器内核」的方案要多背
// 70MB 以上。这里只做**薄壳**：用系统自带的 WebView 打开本地回环地址，
// 面板、API、Cookie、SSE 全部原样复用。
//
// ## 平台分工
//
//   - Windows：WebView2（Win10/11 自带）。无边框窗口 + 自绘标题栏，
//     拖动 / 最小化 / 最大化 / 关闭走本包注入的 JS 桥。
//   - Linux：系统 WebKitGTK（缺库或没有图形会话时返回 ErrUnsupported，
//     由调用方回退到系统浏览器）。使用窗口管理器提供的原生标题栏。
//   - macOS：系统 WKWebView + Cocoa 原生标题栏。窗口必须在主线程创建，
//     因此调用顺序是「先 shell.New，后 tray.Run」（托盘会占用主线程跑消息循环）。
//     只在 `cfp_gui` 标签下编入，且产物必须在 macOS 上构建（cgo + AppKit）。
//   - 其他平台：ErrUnsupported。
//
// ## 安全边界
//
// 窗口只加载 127.0.0.1 的回环地址，仍是启动令牌 → 会话 Cookie 那一套，
// 不新建任何监听端口，也不改变 server 包的四道门。
// 外部链接一律交给系统浏览器（面板里本来就走 openExternal）。
// 发布构建关闭 DevTools 与右键菜单。
package shell

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrUnsupported 表示当前平台（或当前环境）无法提供内嵌窗口。
// 调用方应当回退到系统浏览器，而不是把它当成启动失败。
var ErrUnsupported = errors.New("当前环境不支持内嵌窗口")

// ErrAlreadyRunning 表示已经有一个面板窗口在运行。
// 本进程已被唤醒过一次（窗口已置前），应当安静退出。
var ErrAlreadyRunning = errors.New("面板窗口已在运行")

// ChromeMode 描述窗口由谁绘制标题栏。
type ChromeMode string

const (
	// ChromeCustom 表示无边框窗口：标题栏由面板自己绘制（Windows）。
	ChromeCustom ChromeMode = "custom"
	// ChromeNative 表示使用系统窗口装饰（Linux / macOS）。
	ChromeNative ChromeMode = "native"
)

// Options 是创建窗口的入参。
type Options struct {
	// Title 是窗口标题（也是托盘「打开面板」时的查找依据）。
	Title string
	// URL 是带启动令牌的回环地址（server.WelcomeURL 的返回值）。
	URL string
	// DataDir 是 WebView 的用户数据目录（Cookie、缓存）。
	// 应指向配置目录下的私有子目录。
	DataDir string
	// Width / Height 是初始窗口尺寸（像素）。
	Width  int
	Height int
	// OpenExternal 把外部链接交给系统浏览器。
	OpenExternal func(url string) error
	// Logf 是可选的日志输出（默认丢弃）。
	Logf func(format string, args ...any)
}

func (o Options) logf(format string, args ...any) {
	if o.Logf != nil {
		o.Logf(format, args...)
	}
}

// Panel 是一个已经打开（或正在关闭）的面板窗口。
type Panel interface {
	// Show 显示并置前窗口；page 非空时切到对应页签。
	// 返回 false 表示窗口已经不可用（调用方应回退到浏览器）。
	Show(page string) bool
	// Hide 把窗口收起来（等同用户点关闭按钮）。
	Hide()
	// Wait 阻塞到窗口循环结束（用户退出或 Close 被调用）。
	Wait()
	// Close 结束窗口循环并销毁窗口。
	Close()
	// Chrome 返回标题栏归属，供面板决定是否绘制自绘标题栏。
	Chrome() ChromeMode
	// Platform 返回平台标识（windows / linux / darwin / other）。
	Platform() string
}

// 桥命令。JS 侧统一走 cfpilotShellCommand(JSON.stringify({cmd, url}))。
const (
	CmdMin          = "min"
	CmdMax          = "max"
	CmdClose        = "close"
	CmdDrag         = "drag"
	CmdOpenExternal = "open-external"
)

type command struct {
	Cmd string `json:"cmd"`
	URL string `json:"url"`
}

func decodeCommand(raw string) (command, error) {
	var c command
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return command{}, fmt.Errorf("命令不是合法 JSON：%w", err)
	}
	return c, nil
}

// InitScript 返回注入到每个页面的引导脚本。
//
// 它只做两件事：
//  1. 暴露 window.__cfpilotShell，让界面知道自己在应用窗口里、
//     标题栏由谁绘制；
//  2. 把界面动作转成一次 cfpilotShellCommand 调用。
//
// 页面在浏览器里（容器 / 局域网 / 安卓）**不会**有这段脚本，
// 因此界面必须 feature-detect（adapter 里的 windowApi 就是这么做的）。
func InitScript(platform string, chrome ChromeMode) string {
	return fmt.Sprintf(`(function () {
  if (window.__cfpilotShell) return;
  window.__cfpilotShell = {
    host: 'window',
    platform: %q,
    chrome: %q,
    send: function (cmd, url) {
      try {
        window.cfpilotShellCommand(JSON.stringify({ cmd: cmd, url: url || '' }));
      } catch (e) { /* 桥不可用时静默降级 */ }
    }
  };
})();`, platform, string(chrome))
}

// pageScript 生成「切到某个页签」的脚本。
//
// 不依赖 renderer 暴露函数：直接点导航按钮，和用户操作走同一条路径，
// 也不会把 renderer 的内部实现变成公共契约。
func pageScript(page string) string {
	return fmt.Sprintf(`(function () {
  var btn = document.querySelector('#nav button[data-page=%q]');
  if (btn) btn.click();
})();`, page)
}

// sanitizePage 只放行形如 "scan" / "deploy" 的简单页签名，
// 避免把托盘/命令行的输入拼进要执行的脚本。
func sanitizePage(page string) string {
	if page == "" || len(page) > 24 {
		return ""
	}
	for _, r := range page {
		if (r < 'a' || r > 'z') && r != '-' {
			return ""
		}
	}
	return page
}

// externalAllowed 只放行 https，避免被构造出 file: / javascript: 等协议。
func externalAllowed(url string) bool {
	return len(url) > 8 && url[:8] == "https://"
}
