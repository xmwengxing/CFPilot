package server

// 网络与域名相关的小工具。

import (
	"net"
	"strings"
	"time"
)

// netDialTimeout 带超时的 TCP 拨号（仅用于连通性探测）。
func netDialTimeout(addr string, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	return d.Dial("tcp", addr)
}

// normalizePagesHost 规范化 Pages 域名。
//
// Pages 的 `project.subdomain` 字段有时**已经带 `.pages.dev` 后缀**，
// 有时不带（不同 API 版本行为不一致）。
// 早期实现直接拼 `.pages.dev`，得到 `cpdata.pages.dev.pages.dev`，
// 用户拿去优选必然全部失败。
//
// 规则：反复剥离所有 `.pages.dev` 后缀，最后只补一次。
func normalizePagesHost(host string) string {
	h := strings.TrimSpace(host)
	if h == "" {
		return ""
	}
	// 去掉协议与路径
	h = strings.TrimPrefix(h, "https://")
	h = strings.TrimPrefix(h, "http://")
	if idx := strings.IndexAny(h, "/?#"); idx >= 0 {
		h = h[:idx]
	}
	h = strings.TrimSuffix(h, "/")
	if h == "" {
		return ""
	}

	// 循环剥离（防止 `a.pages.dev.pages.dev`）
	for strings.HasSuffix(strings.ToLower(h), ".pages.dev") {
		h = h[:len(h)-len(".pages.dev")]
	}
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return ""
	}
	return h + ".pages.dev"
}
