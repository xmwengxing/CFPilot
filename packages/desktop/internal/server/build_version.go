package server

// 从内核产物里提取版本串。
//
// ## 版本串格式
//
// 构建脚本注入的形如 `<git短hash>-<源码内容哈希前8位>`，例如 `a946dfa-1f2e3d4c`。
// 早期格式是纯数字（12 位时间戳，如 `202610251200`），也要兼容。
//
// ## ⚠️ 读不到就返回空串，绝不返回 "unknown"
//
// 曾有过的事故：向导往 KV 清单里写 `"build": "unknown"`，
// 于是「检查状态」显示「线上内核 unknown ≠ 本地 a946dfa-xxx」，
// 用户完全看不懂那是什么。空串的语义是「未知」，由调用方决定怎么显示。

import (
	"regexp"
	"strings"
)

var (
	// <7~10 位十六进制 git hash>-<4~16 位十六进制 或 12 位数字>
	reBuildHash = regexp.MustCompile(`["']([0-9a-f]{7,10}-(?:[0-9a-f]{4,16}|[0-9]{12}))["']`)
	// 纯数字版本（旧格式）
	reBuildNumeric = regexp.MustCompile(`["'](\d{10,14})["']`)
)

// extractBuildVersion 从产物源码里找版本串。
func extractBuildVersion(source string) string {
	if m := reBuildHash.FindStringSubmatch(source); len(m) > 1 {
		return m[1]
	}
	if m := reBuildNumeric.FindStringSubmatch(source); len(m) > 1 {
		return m[1]
	}
	return strings.TrimSpace("")
}
