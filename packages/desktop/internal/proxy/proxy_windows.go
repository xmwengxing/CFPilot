//go:build windows

package proxy

import (
	"net"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// Windows 系统代理存在 WinINET 的注册表里：
//
//	HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
//	  ProxyEnable   (REG_DWORD)  1 = 启用
//	  ProxyServer   (REG_SZ)    形如 "127.0.0.1:7890" 或 "http=127.0.0.1:7890;https=127.0.0.1:7890"
//	  ProxyOverride (REG_SZ)    不走代理的地址列表
//
// ⚠️ PAC（Proxy Auto-Config）脚本不在这里 ——
//
//	那需要跑 JS 求值，桌面版不引入 JS 引擎。
//	这种情况下用户通常会改用「系统代理 = 固定地址」的模式。
const (
	internetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`
	proxyEnableValue    = "ProxyEnable"
	proxyServerValue    = "ProxyServer"
)

// errInvalidData 是 Windows 的 ERROR_INVALID_DATA（13）。
//
// ⚠️ syscall 包里没有导出这个常量，只能用数值 ——
//
//	Windows 的错误码定义见 winerror.h。
const errInvalidData syscall.Errno = 13

// systemProxy 解析 Windows 的代理配置。
//
// 返回 ok=false 表示「没找到可用代理」—— 调用方应当直连。
//
// ## 两条来源，谁先用谁生效
//
//  1. **系统代理注册表**（ProxyEnable=1）—— 用户显式开了系统代理；
//  2. **常见代理端口探测** —— 见 probeLocalProxy。
func systemProxy() (*url.URL, string, bool) {
	// ---- 1. 系统代理已启用 ----
	if enable, _, err := readRegistryDWORD(proxyEnableValue); err == nil && enable != 0 {
		if raw, _, err := readRegistryString(proxyServerValue); err == nil {
			if target := pickProxyTarget(strings.TrimSpace(raw)); target != "" {
				if u, err := parseProxyURL(target); err == nil {
					return u, "Windows 系统代理 " + target, true
				}
			}
		}
	}

	// ---- 2. 系统代理没开，但本机有代理程序在跑 ----
	//
	// ⚠️ 这一条很关键：不少代理工具默认**不装**系统代理
	//    （或用户手动关掉了那个开关），只监听本地端口。
	//    这时注册表里 ProxyEnable=0，但代理其实**开着** ——
	//    程序要是只看注册表，就会直连 GitHub 然后超时。
	if u, port, ok := probeLocalProxy(); ok {
		return u, "本机代理端口 " + port, true
	}

	return nil, "", false
}

// commonProxyPorts 是本地代理程序常用的端口。
//
// 覆盖 Clash / v2rayN / sing-box / Shadowsocks / trojan 等的默认端口
// 及其 HTTP 入口（多数工具的 HTTP 与 SOCKS 同端口或相差 1）。
var commonProxyPorts = []int{10808, 7890, 7897, 7891, 1080, 10809, 8080, 8888, 20171, 33210}

// probeLocalProxy 探测本机是否有代理程序在监听。
//
// 判据是「该端口有人在听，且能建立 TCP 连接」——
// 光看端口被占用不够（可能是别的程序占着同一个号）。
//
// ⚠️ 只探 127.0.0.1 —— 代理程序都监听回环地址。
func probeLocalProxy() (*url.URL, string, bool) {
	for _, port := range commonProxyPorts {
		addr := net.JoinHostPort("127.0.0.1", itoa(port))
		conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
		if err != nil {
			continue
		}
		_ = conn.Close()
		u, err := parseProxyURL("http://" + addr)
		if err != nil {
			continue
		}
		return u, addr, true
	}
	return nil, "", false
}

// itoa 是 strconv.Itoa 的本地副本（避免为一个函数引入 strconv）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// pickProxyTarget 从 ProxyServer 里挑出要用的地址。
//
// ProxyServer 有三种常见写法：
//
//	"127.0.0.1:7890"                              —— 全部协议用这一个
//	"http=127.0.0.1:7890;https=127.0.0.1:7890"   —— 分协议
//	"socks=127.0.0.1:1080"                        —— 只有 socks
//
// 桌面版访问的是 https（GitHub），所以优先取 https 项；
// 没有 https 项时退回第一个通用项。
func pickProxyTarget(raw string) string {
	// 分协议写法
	if strings.Contains(raw, "=") {
		var generic, httpOnly, httpsOnly string
		for _, part := range strings.Split(raw, ";") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			k, v, ok := strings.Cut(part, "=")
			if !ok {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(k)) {
			case "https":
				httpsOnly = strings.TrimSpace(v)
			case "http":
				httpOnly = strings.TrimSpace(v)
			default:
				generic = strings.TrimSpace(v)
			}
		}
		if httpsOnly != "" {
			return httpsOnly
		}
		if httpOnly != "" {
			return httpOnly
		}
		if generic != "" {
			return generic
		}
		return ""
	}
	// 单地址写法
	return raw
}

// readRegistryString 读 Internet Settings 下的字符串值。
func readRegistryString(name string) (string, bool, error) {
	key, err := openInternetSettings()
	if err != nil {
		return "", false, err
	}
	defer func() { _ = syscall.RegCloseKey(key) }()

	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return "", false, err
	}
	var valType uint32
	var size uint32
	err = syscall.RegQueryValueEx(key, namePtr, nil, &valType, nil, &size)
	if err != nil {
		return "", false, err
	}
	if size == 0 || (valType != syscall.REG_SZ && valType != syscall.REG_EXPAND_SZ) {
		return "", false, errInvalidData
	}
	buf := make([]uint16, size/2+1)
	err = syscall.RegQueryValueEx(key, namePtr, nil, &valType, (*byte)(unsafe.Pointer(&buf[0])), &size)
	if err != nil {
		return "", false, err
	}
	return syscall.UTF16ToString(buf), true, nil
}

// readRegistryDWORD 读 Internet Settings 下的 DWORD 值。
func readRegistryDWORD(name string) (uint32, bool, error) {
	key, err := openInternetSettings()
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = syscall.RegCloseKey(key) }()

	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, false, err
	}
	var valType uint32
	var value uint32
	size := uint32(4)
	err = syscall.RegQueryValueEx(key, namePtr, nil, &valType, (*byte)(unsafe.Pointer(&value)), &size)
	if err != nil {
		return 0, false, err
	}
	if valType != syscall.REG_DWORD {
		return 0, false, errInvalidData
	}
	return value, true, nil
}

// openInternetSettings 打开 Internet Settings 注册表键（只读）。
func openInternetSettings() (syscall.Handle, error) {
	var key syscall.Handle
	path, err := syscall.UTF16PtrFromString(internetSettingsKey)
	if err != nil {
		return 0, err
	}
	err = syscall.RegOpenKeyEx(
		syscall.HKEY_CURRENT_USER,
		path,
		0,
		syscall.KEY_READ,
		&key,
	)
	if err != nil {
		return 0, err
	}
	return key, nil
}
