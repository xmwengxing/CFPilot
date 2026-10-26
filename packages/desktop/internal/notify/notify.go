package notify

// 启动提示：服务启动成功时告知用户。
//
// ## 为什么需要这个
//
// 用户反馈「运行程序后没有任何提示」—— 双击后如果浏览器没自动打开
// （或者打开慢），用户完全不知道程序干了什么、有没有起来。
// 桌面程序必须有**启动反馈**。
//
// ## 各平台的实现方式
//
// Windows 上有两种可选：
//
//  1. **托盘气泡**（Shell_NotifyIcon + NIF_INFO）
//     缺点：依赖托盘图标已存在，必须在 systray 的 onReady 之后调用；
//     且 Windows 10/11 会把气泡转到「通知中心」，行为不完全可控。
//  2. **系统 Toast**（Windows.UI.Notifications）
//     缺点：需要注册 AppUserModelID + 快捷方式，未签名的绿色程序
//     常常被系统静默丢弃，可靠性差。
//
// 本项目选 **托盘气泡** —— 因为托盘图标必然存在（这是托盘应用），
// 且 systray 库已经提供了 SetTooltip 之类的能力，
// 用它自己的通知通道最稳。实现见 internal/tray 的 Notify()。
//
// Linux：用 `notify-send`（libnotify），几乎所有桌面环境都有；
// 没有就退回 stderr 打印（服务器环境也能看到）。
//
// macOS：用 `osascript -e 'display notification ...'`，系统自带。

import (
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Message 是一条通知。
type Message struct {
	// Title 是标题（Windows 上会作为托盘气泡标题）
	Title string
	// Body 是正文
	Body string
}

// StartupMessage 生成「服务已启动」的提示内容。
//
// url 是用户应访问的地址；lanMode 表示是否开了局域网访问。
func StartupMessage(url string, port int, lanMode bool) Message {
	body := "服务已启动，界面地址：\n" + url
	if lanMode {
		body += "\n\n已开启局域网访问"
	}
	return Message{
		Title: "CFPilot 部署与维护服务",
		Body:  body,
	}
}

// ShowViaShell 在不支持托盘气泡的场景下，用系统命令弹通知。
//
// 用于：
//   - Linux / macOS（托盘气泡由 systray 提供的能力有限）
//   - Windows 上托盘不可用时的降级（--no-tray 模式 / 服务会话）
//
// 失败只记日志，不影响主流程 —— 通知是锦上添花，不是必需功能。
func ShowViaShell(msg Message) {
	switch runtime.GOOS {
	case "linux":
		showLinux(msg)
	case "darwin":
		showDarwin(msg)
	case "windows":
		showWindows(msg)
	}
}

// showWindows 在 Windows 上弹一个**非阻塞**的气泡提示。
//
// ## 为什么不用 MessageBox
//
// MessageBox 是模态的 —— 用户不点「确定」程序就卡住。
// 启动提示绝不能阻塞主流程。
//
// ## 怎么做
//
// 用 PowerShell 的 NotifyIcon 造一个临时托盘图标弹气泡，
// 6 秒后自动销毁。这样即使主程序是 --no-tray 模式也能看到提示。
//
// ⚠️ Session 0（服务会话 / CI）里没有桌面，这一步会失败 ——
// 那种环境本来就看不到通知，只记日志即可。
func showWindows(msg Message) {
	// PowerShell 单引号字符串里，单引号要写两遍；换行用 `n
	safe := func(s string) string {
		s = strings.ReplaceAll(s, "'", "''")
		s = strings.ReplaceAll(s, "\r\n", "`n")
		s = strings.ReplaceAll(s, "\n", "`n")
		return s
	}
	script := "Add-Type -AssemblyName System.Windows.Forms;" +
		"$n=New-Object System.Windows.Forms.NotifyIcon;" +
		"$n.Icon=[System.Drawing.SystemIcons]::Information;" +
		"$n.Visible=$true;" +
		"$n.ShowBalloonTip(5000,'" + safe(msg.Title) + "','" + safe(msg.Body) + "','Info');" +
		"Start-Sleep -Seconds 6;" +
		"$n.Visible=$false;$n.Dispose()"

	cmd := exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script)
	if err := cmd.Start(); err != nil {
		log.Printf("[cfpilot] %s: %s（通知失败：%v）", msg.Title, oneLine(msg.Body), err)
		return
	}
	// 不等待 —— 通知在后台自己显示完退出
	go func() { _ = cmd.Wait() }()
}

// showLinux 用 notify-send 发桌面通知。
//
// 参数说明：
//   - `-a` 应用名
//   - `-t` 超时（毫秒）—— 5 秒后自动消失
//   - `-i` 图标名（用通用图标，避免依赖自定义图标安装位置）
func showLinux(msg Message) {
	if _, err := exec.LookPath("notify-send"); err != nil {
		log.Printf("[cfpilot] %s: %s（未安装 notify-send，仅此日志）", msg.Title, oneLine(msg.Body))
		return
	}
	cmd := exec.Command("notify-send",
		"-a", "CFPilot",
		"-t", "5000",
		"-i", "network-server",
		msg.Title,
		msg.Body,
	)
	if err := cmd.Start(); err != nil {
		log.Printf("[cfpilot] 桌面通知失败：%v（内容：%s: %s）", err, msg.Title, oneLine(msg.Body))
	}
}

// showDarwin 用 osascript 发通知。
func showDarwin(msg Message) {
	script := fmt.Sprintf(
		`display notification %s with title %s`,
		appleScriptString(msg.Body),
		appleScriptString(msg.Title),
	)
	if err := exec.Command("osascript", "-e", script).Start(); err != nil {
		log.Printf("[cfpilot] 系统通知失败：%v（内容：%s: %s）", err, msg.Title, oneLine(msg.Body))
	}
}

// appleScriptString 把字符串转成 AppleScript 字面量（转义双引号与反斜杠）。
func appleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return `"` + s + `"`
}

// oneLine 把多行文本压成一行（日志用）。
func oneLine(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
}

// WaitASec 给桌面环境一点时间把通知渲染出来（仅用于测试）。
var _ = time.Second
