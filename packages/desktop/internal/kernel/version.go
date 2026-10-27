package kernel

// 内核版本的 semver 比较。
//
// ## 为什么需要它
//
// 内核的 **build 指纹**（形如 `a946dfa-1f2e3d4c`）是精确的，
// 但它**没有大小顺序** —— 两个指纹谁新谁旧无从判断。
// 于是「线上 build ≠ 本地 build」只能说明「不一样」，
// 说不清「谁更新」。
//
// 而**发布版本号**（semver，如 `0.7.6`）自带大小顺序，
// 因此部署清单里除了 build 指纹，还要记一份 semver，
// 用户界面才能回答「线上比我旧还是新」。
//
// ## 与 update.CompareVersion 的关系
//
// `internal/update.CompareVersion` 比较的是 [3]int 三元组，
// 服务于「检查更新」；本文件比较的是**字符串** semver，
// 服务于「内核版本」场景（远程内核 / 清单里的版本）。
//
// 两者语义不同，**不要合并**：
//   - update 那边解析失败时返回 [0,0,0]（当 0.0.0 处理）
//   - 本这边解析失败时视为**更旧**（返回 -1 / 1）
//
// 后者更保守：读不出版本号时，宁可说「对方更新，需要更新」，
// 也不要谎称「已经是最新的」。

import (
	"regexp"
	"strconv"
	"strings"
)

// semverRe 匹配版本号主体。
//
// 允许：
//   - 可选的 `v` 前缀（tag 形态）
//   - 1~3 段数字（缺省段按 0 处理：`0.7` 等价于 `0.7.0`）
//   - 可选的预发布后缀（`-rc1`）或构建元数据（`+20261028`）
//
// 捕获组：
//  1. major
//  2. minor（可缺省）
//  3. patch（可缺省）
//  4. 后缀（含分隔符 `-` / `+`）
var semverRe = regexp.MustCompile(`^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$`)

// semver 是解析后的版本号。
type semver struct {
	// nums 是 major / minor / patch
	nums [3]int
	// pre 是预发布标识（`rc1` / `beta.2`），没有则为空
	pre string
	// hasPre 表示带预发布标识
	hasPre bool
}

// parseSemver 解析版本号，解析不出来时 ok 为 false。
func parseSemver(s string) (semver, bool) {
	var v semver
	t := strings.TrimSpace(s)
	if t == "" {
		return v, false
	}
	m := semverRe.FindStringSubmatch(t)
	if m == nil {
		return v, false
	}
	// 数字段不能为空（正则已保证至少有 major）
	major, err := strconv.Atoi(m[1])
	if err != nil {
		return v, false
	}
	v.nums[0] = major
	if m[2] != "" {
		n, err := strconv.Atoi(m[2])
		if err != nil {
			return v, false
		}
		v.nums[1] = n
	}
	if m[3] != "" {
		n, err := strconv.Atoi(m[3])
		if err != nil {
			return v, false
		}
		v.nums[2] = n
	}

	// 后缀：`-rc1` 是预发布，`+build` 只是构建元数据（不影响优先级）
	switch rest := m[4]; {
	case rest == "":
	case strings.HasPrefix(rest, "-"):
		pre := strings.TrimPrefix(rest, "-")
		if pre == "" {
			return v, false
		}
		v.pre = pre
		v.hasPre = true
	case strings.HasPrefix(rest, "+"):
		// 构建元数据：按 semver 规范忽略
	default:
		// 形如 `0.7.6abc` —— 不是合法版本号
		return v, false
	}
	return v, true
}

// CompareSemver 比较两个 semver 版本号：a > b 返回正数，a < b 返回负数，相等返回 0。
//
// ## 解析失败的处理
//
// **解析不出来的一方视为更旧**：
//
//   - a 解析不出、b 能解析 → 返回 -1（a 更旧）
//   - a 能解析、b 解析不出 → 返回 1
//   - 两边都解析不出   → 返回 0
//
// 空串、非法字符串都算「解析不出来」。
//
// ## 预发布版本
//
// 按 semver 规范：`1.0.0-rc1` **旧于** `1.0.0`；
// 两个预发布版本之间按点分标识逐段比较（纯数字标识小于字母数字标识）。
func CompareSemver(a, b string) int {
	va, okA := parseSemver(a)
	vb, okB := parseSemver(b)

	switch {
	case !okA && !okB:
		return 0
	case !okA:
		return -1
	case !okB:
		return 1
	}

	for i := 0; i < 3; i++ {
		if va.nums[i] != vb.nums[i] {
			if va.nums[i] > vb.nums[i] {
				return 1
			}
			return -1
		}
	}
	return comparePrerelease(va, vb)
}

// comparePrerelease 比较两个预发布标识。
//
// 没有预发布标识的（正式版）**新于**有预发布标识的。
func comparePrerelease(a, b semver) int {
	switch {
	case !a.hasPre && !b.hasPre:
		return 0
	case !a.hasPre:
		return 1
	case !b.hasPre:
		return -1
	}

	as := strings.Split(a.pre, ".")
	bs := strings.Split(b.pre, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		if c := comparePreIdentifier(as[i], bs[i]); c != 0 {
			return c
		}
	}
	// 逐段相同：标识更多的更新（`1.0.0-rc.1` > `1.0.0-rc`）
	switch {
	case len(as) > len(bs):
		return 1
	case len(as) < len(bs):
		return -1
	}
	return 0
}

// comparePreIdentifier 比较单个预发布标识。
//
// semver 规则：
//   - 纯数字标识按数值比较，且**优先级低于**字母数字标识
//   - 字母数字标识按字典序比较
func comparePreIdentifier(a, b string) int {
	an, aErr := strconv.Atoi(a)
	bn, bErr := strconv.Atoi(b)
	switch {
	case aErr == nil && bErr == nil:
		if an != bn {
			if an > bn {
				return 1
			}
			return -1
		}
		return 0
	case aErr == nil:
		return -1 // 数字标识优先级更低
	case bErr == nil:
		return 1
	default:
		return strings.Compare(a, b)
	}
}
