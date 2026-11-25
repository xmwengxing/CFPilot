//go:build darwin && !cfp_gui

package shell

// New 在「未启用图形壳」的 darwin 构建里明确返回 ErrUnsupported。
//
// ## 为什么 darwin 也要分两种构建
//
// 面板窗口依赖 WKWebView / AppKit，只能通过 cgo 调用（见 shell_darwin.m）。
// 纯服务型构建（例如给 macOS 上的容器 / CI 环境跑的静态产物）不需要窗口，
// 也不该为此背上 cgo 与框架依赖 —— 那类构建用 --no-browser 起回环服务，
// 由调用方或其他进程访问。
//
// 注意：本文件只决定**窗口**有无。darwin 上托盘（energye/systray）
// 本身就是 cgo，所以 CGO_ENABLED=0 的 darwin 构建仍然编不过 ——
// 这是上游依赖的实现方式决定的，不是本包的取舍。
func New(opts Options) (Panel, error) {
	opts.logf("[shell] 本构建未启用图形壳，使用系统浏览器")
	return nil, ErrUnsupported
}

// ActivateExisting 在无图形壳的构建里恒为 false。
func ActivateExisting(string) bool { return false }
