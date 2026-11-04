package relay

import (
	_ "embed"
	"strings"
)

// builtinCandidates 是随版本发布的反代候选清单（用户不可修改）。
//
// 构建期由 `scripts/build-desktop.mjs` 从 `packages/cli/assets/` 复制过来，
// 与 CLI 用的是**同一份文件** —— 两边分别维护必然漂移。
//
//go:embed assets/relay-ip-builtin.txt
var builtinCandidatesRaw string

// BuiltinCandidates 返回内置候选（纯 IPv4 字符串）。
//
// 手工上手上没有反代 IP 源时，这是「反代优选」唯一能开跑的输入。
func BuiltinCandidates() []string {
	out := make([]string, 0, 64)
	seen := make(map[string]struct{}, 64)
	for _, line := range strings.Split(builtinCandidatesRaw, "\n") {
		ip := strings.TrimSpace(line)
		if idx := strings.Index(ip, "#"); idx >= 0 {
			ip = strings.TrimSpace(ip[:idx])
		}
		if ip == "" || strings.Contains(ip, ":") {
			continue
		}
		// 只接受合法的点分四段（内置文件是生成物，这里只做兜底校验）
		parts := strings.Split(ip, ".")
		if len(parts) != 4 {
			continue
		}
		valid := true
		for _, part := range parts {
			if part == "" || len(part) > 3 {
				valid = false
				break
			}
			for _, ch := range part {
				if ch < '0' || ch > '9' {
					valid = false
					break
				}
			}
		}
		if !valid {
			continue
		}
		if _, dup := seen[ip]; dup {
			continue
		}
		seen[ip] = struct{}{}
		out = append(out, ip)
	}
	return out
}
