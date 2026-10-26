//go:build windows

package main

import (
	"os/exec"
	"strings"
)

// showMessageBox 在 Windows 上弹一个系统消息框。
//
// 本程序以 -H=windowsgui 编译（双击不弹黑框），这种情况下 stderr 是
// 无效句柄，写日志等于没写。启动失败时用户只会看到「双击没反应」，
// 所以必须用图形方式把原因说出来。
func showMessageBox(title, text string) {
	// 用 PowerShell 的 MessageBox，避免引入 cgo / syscall 依赖
	safe := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	script := "Add-Type -AssemblyName System.Windows.Forms;" +
		"[System.Windows.Forms.MessageBox]::Show('" + safe(text) + "','" + safe(title) + "')"
	_ = exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script).Start()
}
