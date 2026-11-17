//go:build mesh && !windows

package main

import "fmt"

// Linux 下由 systemd 管理守护进程，不需要 Go 侧注册服务。
func runAsService(run func()) { run() }
func installService() {
	fmt.Println("Linux 请用 deb 包安装（自带 systemd 单元），无需手动注册服务")
}
func uninstallService() { fmt.Println("Linux 请用 apt remove cfpilot-mesh 卸载") }
