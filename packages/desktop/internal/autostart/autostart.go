// Package autostart 管理 CFPilot 应用的登录自启。
//
// 这里只控制「用户桌面会话启动后拉起 CFPilot 托盘」。
// 组网服务自身的开机启动由安装包注册的 cfpilot-meshd 服务负责，
// 最后选择的网络档案由 meshd 启动时自动恢复。
package autostart

import "errors"

// ErrUnsupported 表示当前平台没有实现登录自启。
var ErrUnsupported = errors.New("当前平台不支持开机自启")
