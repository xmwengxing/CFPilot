//go:build windows

package mesh

import "syscall"

// setV6Only 在 bind 之前设置 IPV6_V6ONLY。
//
// Windows 上 `[::]` 的默认值随系统/套接字选项而定，不显式关掉就可能只收 IPv6
// （MobiHop 在真机踩过：`listen = "[::]:51820"` 只通 v6，IPv4 中继完全收不到）。
// Go 的 net 包对 "udp" + 未指定地址一般会关掉它，但平台差异不值得赌。
func setV6Only(fd uintptr, v6only int) error {
	return syscall.SetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IPV6, syscall.IPV6_V6ONLY, v6only)
}
