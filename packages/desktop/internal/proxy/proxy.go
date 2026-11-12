// Package proxy 统一解析「访问 GitHub 时该走哪个代理」。
//
// # 为什么需要它
//
// 桌面版要访问 GitHub（查版本、下载内核、查更新），而在国内网络下
// 直连 GitHub 常常超时。用户明明开着代理，桌面版却连不上 ——
// 因为 Go 的 net/http **只认 HTTP_PROXY / HTTPS_PROXY 环境变量**，
// 不认 Windows 的「系统代理」设置。
//
// 而绝大多数代理工具（Clash、v2rayN、sing-box 等）默认装的是
// **系统代理**：它们改的是 WinINET 的注册表设置，不是环境变量。
// 于是桌面版在「用户已开代理」的情况下依然直连 GitHub → 超时。
//
// # 优先级
//
//  1. HTTPS_PROXY / HTTP_PROXY 环境变量（显式设置，最明确）
//  2. Windows 系统代理注册表（用户装了系统代理，桌面版应该尊重）
//  3. 直连
//
// # 为什么不用 golang.org/x/sys
//
// 读注册表用标准库的 syscall.RegOpenKeyEx 就够了
// （Windows 才有这些符号，所以放在 proxy_windows.go 里，
//
//	其它平台编译 proxy_other.go 的空实现）。
//
// 不引入新依赖 —— 桌面版要保持单文件、小体积、无三方运行时依赖。
package proxy

import (
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Resolver 解析出的代理配置。
type Resolver struct {
	// URL 是要使用的代理地址；为空表示直连。
	URL *url.URL
	// Source 说明这个代理是怎么来的（用于日志与排障）。
	Source string
}

// Resolve 按优先级解析代理配置。
//
// 这是**包级便捷函数** —— 绝大多数调用方只想「拿到一个能用的 Client」。
func Resolve() Resolver {
	// ---- 1. 环境变量 ----
	// ⚠️ HTTPS_PROXY 优先：https 请求走 HTTPS_PROXY，http 走 HTTP_PROXY。
	//    只看 HTTPS_PROXY 会让 http 镜像源绕过代理。
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			continue
		}
		u, err := parseProxyURL(raw)
		if err != nil {
			continue
		}
		return Resolver{URL: u, Source: "环境变量 " + key}
	}

	// ---- 2. Windows 系统代理 ----
	if u, source, ok := systemProxy(); ok {
		return Resolver{URL: u, Source: source}
	}

	// ---- 3. 直连 ----
	return Resolver{Source: "直连"}
}

// parseProxyURL 解析代理地址，兼容没写协议的常见写法。
//
// "127.0.0.1:7890" 这种写法在 Go 的 url.Parse 里会被当成
// 「scheme=127.0.0.1」而解析失败，所以补一个默认的 http://。
func parseProxyURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, os.ErrInvalid
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Host == "" {
		return nil, os.ErrInvalid
	}
	return u, nil
}

// Client 返回一个使用该代理配置的 HTTP 客户端。
//
// timeout 为零表示不设客户端级超时（由请求上下文控制）。
//
// ⚠️ 必须**克隆 http.DefaultTransport**再改 Proxy：
//
//	直接 new 一个空 Transport 会丢掉默认的连接池、
//	TLS 握手超时、Expect: 100-continue 处理等一堆设定。
func (r Resolver) Client(timeout time.Duration) *http.Client {
	c := &http.Client{Timeout: timeout}
	if r.URL != nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.Proxy = http.ProxyURL(r.URL)
		c.Transport = t
	}
	return c
}
