//go:build !windows

package tray

// 非 Windows 平台没有「托盘气泡」概念，用系统通知替代。
//
// Linux：notify-send（libnotify）
// macOS：osascript display notification
//
// 实现见 internal/notify 包；这里的 ShowBalloon 只是把调用转过去，
// 保持与 Windows 版同签名，调用方无需区分平台。

import (
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/notify"
)

// ShowBalloon 在非 Windows 平台用系统通知实现同等效果。
func (a *App) ShowBalloon(title, body string, timeout time.Duration) error {
	notify.ShowViaShell(notify.Message{Title: title, Body: body})
	return nil
}
