//go:build darwin && cfp_gui

package shell

/*
// 本文件只负责把 Objective-C 侧的页面桥接回 Go。
//
// ⚠️ 为什么单独一个文件：cgo 规定「用了 //export 的文件，前导代码里只能有声明」，
// 而 shell_darwin.go 的前导代码里是整段 Objective-C 实现（定义），
// 两者不能放在同一个文件里。原生侧的 extern 声明就在那边。
*/
import "C"

// cfpShellCommandFromJS 是 WKWebView 消息处理器回调进来的入口。
//
// 名字与签名必须和 shell_darwin.go 前导代码里的 `extern void
// cfpShellCommandFromJS(char* raw)` 完全一致，改动要同步两边。
//
// 回调发生在主线程，但这里不做任何 UI 操作（只解析命令、拉起浏览器），
// 因此不需要再切一次主队列。
//
//export cfpShellCommandFromJS
func cfpShellCommandFromJS(raw *C.char) {
	if raw == nil {
		return
	}
	s := C.GoString(raw)

	panelMu.Lock()
	p := curPanel
	panelMu.Unlock()
	if p == nil {
		return
	}
	p.handleCommand(s)
}
