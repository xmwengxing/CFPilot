//go:build !windows

package main

// showMessageBox 在非 Windows 平台直接写 stderr（终端里能看到）。
func showMessageBox(title, text string) {
	println(title + ": " + text)
}
