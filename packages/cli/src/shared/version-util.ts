/**
 * 内核版本号（semver）的比较工具。
 *
 * ## 为什么需要它
 *
 * 内核的 **build 指纹**（形如 `a946dfa-1f2e3d4c`）是精确的，
 * 但它**没有大小顺序** —— 两个指纹谁新谁旧无从判断。
 * 于是「线上 build ≠ 本地 build」只能说明「不一样」，
 * 说不清「谁更新」。
 *
 * 而**发布版本号**（semver，如 `0.7.6`）自带大小顺序，
 * 因此部署清单里除了 build 指纹，还要记一份 semver，
 * 用户界面才能回答「线上比我旧还是新」。
 *
 * ## 与 Go 版的关系
 *
 * 本文件与 `packages/desktop/internal/kernel/version.go` 是**同一套语义**
 * （CLI 与桌面版必须给出完全一致的结论，否则用户会看到
 * 「桌面版说已是最新、CLI 说要更新」这种自相矛盾的提示）。
 *
 * ## 为什么放在 shared 而不是 deploy
 *
 * 「检查状态」的命令行输出（deploy/command.ts）与部署流程
 * （deploy/pages-deploy.ts）都要用它，属于跨模块的公共能力。
 */

/** 解析后的版本号。 */
export interface ParsedVersion {
  /** 主版本号 */
  major: number
  /** 次版本号（缺省按 0 处理：`0.7` 等价于 `0.7.0`） */
  minor: number
  /** 修订号（缺省按 0 处理） */
  patch: number
  /** 预发布标识（点分，如 `rc.1`）；没有则为空数组 */
  prerelease: string[]
}

/**
 * 版本号主体的正则。
 *
 * 允许：
 *   - 可选的 `v` 前缀（tag 形态，如 `v0.7.6`）
 *   - 1~3 段数字（缺省段按 0 处理）
 *   - 尾部只允许预发布标识（`-rc1`）或构建元数据（`+20261028`）
 *
 * 捕获组：
 *  1. major
 *  2. minor（可缺省）
 *  3. patch（可缺省）
 *  4. 尾部（含分隔符 `-` / `+`）
 */
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/

/**
 * 解析版本号；解析不出来时返回 null。
 *
 * 空串、非法字符串、`0.7.6abc`（尾部没有合法分隔符）都算解析不出来。
 */
export function parseVersion(input: string): ParsedVersion | null {
  const text = input.trim()
  if (!text) return null
  const matched = VERSION_RE.exec(text)
  if (!matched) return null

  const major = Number(matched[1])
  const minor = matched[2] === undefined ? 0 : Number(matched[2])
  const patch = matched[3] === undefined ? 0 : Number(matched[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null
  }

  const rest = matched[4] ?? ''
  let prerelease: string[] = []
  if (rest === '') {
    // 无后缀：正式版
  } else if (rest.startsWith('-')) {
    const pre = rest.slice(1)
    if (!pre) return null
    prerelease = pre.split('.')
  } else if (rest.startsWith('+')) {
    // 构建元数据：按 semver 规范忽略（不影响优先级）
  } else {
    // 形如 `0.7.6abc` —— 不是合法版本号
    return null
  }

  return { major, minor, patch, prerelease }
}

/**
 * 比较两个 semver 版本号：a > b 返回正数，a < b 返回负数，相等返回 0。
 *
 * ## 解析失败的处理
 *
 * **解析不出来的一方视为更旧**：
 *
 *   - a 解析不出、b 能解析 → 返回 -1（a 更旧）
 *   - a 能解析、b 解析不出 → 返回 1
 *   - 两边都解析不出   → 返回 0
 *
 * 空串、非法字符串都算「解析不出来」。
 *
 * ## 预发布版本
 *
 * 按 semver 规范：`1.0.0-rc1` **旧于** `1.0.0`；
 * 两个预发布版本之间按点分标识逐段比较（纯数字标识小于字母数字标识）。
 */
export function compareSemver(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)

  if (!va && !vb) return 0
  if (!va) return -1
  if (!vb) return 1

  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1

  return comparePrerelease(va.prerelease, vb.prerelease)
}

/**
 * 比较两个预发布标识。
 *
 * 没有预发布标识的（正式版）**新于**有预发布标识的。
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    // 逐段相同：标识更多的更新（`1.0.0-rc.1` > `1.0.0-rc`）
    if (x === undefined) return -1
    if (y === undefined) return 1
    const c = comparePrereleaseIdentifier(x, y)
    if (c !== 0) return c
  }
  return 0
}

/**
 * 比较单个预发布标识。
 *
 * semver 规则：
 *   - 纯数字标识按数值比较，且**优先级低于**字母数字标识
 *   - 字母数字标识按字典序比较
 */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    const na = Number(a)
    const nb = Number(b)
    if (na !== nb) return na > nb ? 1 : -1
    return 0
  }
  if (aNumeric) return -1 // 数字标识优先级更低
  if (bNumeric) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}
