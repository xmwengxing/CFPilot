//go:build !windows

package proxy

import "net/url"

// systemProxy 在非 Windows 平台上没有「系统代理」这回事 ——
// macOS / Linux 的代理通常由环境变量或系统级设置处理，
// 环境变量已经在 Resolve() 里优先处理过了。
func systemProxy() (*url.URL, string, bool) {
	return nil, "", false
}
