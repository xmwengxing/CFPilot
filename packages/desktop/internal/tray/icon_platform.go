package tray

// 按平台选择托盘图标字节。
//
// ## 为什么必须区分平台
//
// systray 的文档：
//
//	// iconBytes should be the content of .ico for windows and
//	// .ico/.jpg/.png for other platforms.
//
// Windows 走 `LoadImage(..., IMAGE_ICON, LR_LOADFROMFILE)` ——
// 它只认 ICO 格式。喂 PNG 不报错，但拿到的句柄不可用，
// 托盘上就是一个**完全透明的占位**（看得见位置、点得到菜单、没有图案）。
//
// Linux（D-Bus StatusNotifierItem）与 macOS 反而要 PNG。
// 所以这里按 GOOS 分支，两种格式都内嵌。

// trayIconBytes 返回当前平台应使用的图标字节。
func trayIconBytes() []byte {
	if useICOIcon {
		return iconICO
	}
	// Linux / macOS：PNG（32×32，高 DPI 下更清晰）
	return iconPNG32
}
