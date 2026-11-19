//go:build !windows

package mesh

import "syscall"

// setV6Only 在 bind 之前设置 IPV6_V6ONLY（Linux / Android / macOS）。
func setV6Only(fd uintptr, v6only int) error {
	return syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IPV6, syscall.IPV6_V6ONLY, v6only)
}
