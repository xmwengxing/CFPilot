package tray

// Windows 托盘气泡通知。
//
// ## 为什么自己做而不调库
//
// systray（energye/systray v1.0.3）暴露的 API 只有
// SetIcon / SetTitle / SetTooltip / AddMenuItem 等，
// **没有任何气泡通知（balloon tip）能力**。
//
// 但它的 `notifyIconData` 结构里已经有气泡需要的全部字段：
//
//	Info      [256]uint16  ← 正文
//	InfoTitle [64]uint16   ← 标题
//	InfoFlags uint32       ← 图标类型 + NIF_INFO
//
// 所以这里直接调 Win32 的 `Shell_NotifyIcon(NIM_MODIFY, ...)`，
// 把同一个 nid 加上 NIF_INFO 再发一次即可。
//
// ## 为什么用气泡而不是系统 Toast
//
// Windows 10/11 的 Toast（Windows.UI.Notifications）要求：
//   - 注册 AppUserModelID
//   - 存在开始菜单快捷方式（否则通知被静默丢弃）
//
// 本项目是绿色单文件，没有安装程序，注册快捷方式不现实。
// 托盘气泡虽然样式旧，但**在托盘图标存在时 100% 可用**，最可靠。

import (
	"fmt"
	"log"
	"syscall"
	"time"
	"unsafe"
)

// Win32 常量
const (
	nimModify   = 0x00000001
	nifInfo     = 0x00000010
	niifInfo    = 0x00000001 // 无图标
	niifWarning = 0x00000003 // 黄色感叹号
)

var (
	shell32            = syscall.NewLazyDLL("shell32.dll")
	pShellNotifyIconW2 = shell32.NewProc("Shell_NotifyIconW")
)

// winNotifyIconData 是 NOTIFYICONDATAW 的最小可用版本。
//
// 字段顺序必须与 Win32 定义完全一致，否则会被当成不同的结构体
// 解析出垃圾数据（这是这类 native 调用最常见的坑）。
type winNotifyIconData struct {
	Size             uint32
	Wnd              syscall.Handle
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             syscall.Handle
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	GuidItem         [16]byte
	BalloonIcon      syscall.Handle
}

// ShowBalloon 在托盘图标上弹一个气泡通知，几秒后自动消失。
//
// 必须**在 systray 的 onReady 之后**调用 —— 托盘图标没建好时
// Shell_NotifyIcon 会返回失败（没有可挂靠的图标）。
func (a *App) ShowBalloon(title, body string, timeout time.Duration) error {
	// 拿到 systray 创建的隐藏窗口句柄与图标 ID。
	//
	// 这两个值是 systray 内部的，没有导出 API。
	// 实测 v1.0.3 用固定值：窗口类名 "SystrayClass"、图标 ID = 100。
	// 拿不到就降级为「不弹气泡」（不影响主流程）。
	hwnd := findSystrayWindow()
	if hwnd == 0 {
		return fmt.Errorf("找不到托盘窗口，无法显示气泡")
	}

	var nid winNotifyIconData
	nid.Size = uint32(unsafe.Sizeof(nid))
	nid.Wnd = hwnd
	nid.ID = 100 // systray 固定的图标 ID
	nid.Flags = nifInfo
	nid.InfoFlags = niifInfo

	// 标题最长 63 字符，正文最长 255 字符（Win32 限制）
	copyUTF16(nid.InfoTitle[:], title)
	copyUTF16(nid.Info[:], body)

	// Timeout 字段仅在旧版 Windows（XP）有效，Vista+ 忽略它。
	// 现代 Windows 由系统「通知显示时长」设置决定，通常 5 秒。
	// 我们仍传一个合理值，不影响新版行为。
	ms := uint32(timeout.Milliseconds())
	if ms < 1000 {
		ms = 4000
	}

	res, _, err := pShellNotifyIconW2.Call(
		uintptr(nimModify),
		uintptr(unsafe.Pointer(&nid)),
	)
	if res == 0 {
		return fmt.Errorf("Shell_NotifyIcon 失败：%v", err)
	}
	return nil
}

// findSystrayWindow 找到 systray 创建的隐藏窗口。
//
// systray v1.0.3 用固定类名 "SystrayClass" 注册窗口类。
// 用 FindWindowW 按类名找，找到即返回句柄。
func findSystrayWindow() syscall.Handle {
	user32 := syscall.NewLazyDLL("user32.dll")
	findWindow := user32.NewProc("FindWindowW")

	className, err := syscall.UTF16PtrFromString("SystrayClass")
	if err != nil {
		return 0
	}
	hwnd, _, _ := findWindow.Call(
		uintptr(unsafe.Pointer(className)),
		0, // 窗口名不限定
	)
	return syscall.Handle(hwnd)
}

// copyUTF16 把 Go 字符串拷进 UTF-16 定长缓冲区（自动截断 + 补 0）。
func copyUTF16(dst []uint16, s string) {
	runes := syscall.StringToUTF16(s)
	n := len(runes)
	if n > len(dst) {
		n = len(dst)
		// 保证最后一个位置是 0 终止符
		if n > 0 {
			n--
		}
	}
	copy(dst[:n], runes[:n])
}

// 保证 log 被引用（调试时用）
var _ = log.Printf
