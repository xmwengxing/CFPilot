/**
 * 分流规则配置（route profiles）解析。
 *
 * 把 `assets/route-profiles.ini`（Clash 风格的分流规则 + 代理组定义）
 * 内联进内核，使 Clash / mihomo 订阅**自带分流规则** ——
 * 用户导入订阅后不用再自己找规则，YouTube / Netflix / OpenAI 等自动走代理。
 *
 * ## 设计取舍（2026-10-25）
 *
 * **方案 A：构建期内联**，不在运行时发外网请求。
 * 理由：
 *   - 铁律 8 要求零运行时依赖；ini 里的 `ruleset=` 指向的仍是
 *     ACL4SSR 等公共远端 list，**分流数据永远是新的**，
 *     只有「用哪些 list + 怎么分组」的结构固定；
 *   - 运行时 fetch 会给每次订阅增加一次外网请求，失败还要回退，
 *     且 Cloudflare 对 Worker 的出站有限制（铁律 29）。
 *
 * 用户可在 KV 里写 `ROUTE_PROFILE` 覆盖内置配置（留空 = 用内置）。
 *
 * ## ini 格式（与 ACL4SSR / cfnew 一致）
 *
 * ```ini
 * [custom]
 * ruleset=🎯 全球直连,https://.../CFnat.list
 * custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT
 * ```
 *
 * - `ruleset=<策略组>,<规则URL或内联规则>`；
 * - `custom_proxy_group=<组名>\`<类型>\`[<正则>]\`<URL>\`<interval>[`成员...]`，
 *   反引号分隔，与我们熟悉的 subconverter 格式相同。
 */

/** 一条分流规则 */
export interface RouteRule {
  /** 策略组名（如「🚀 节点选择」）；`[]GEOIP,CN` 形式下为目标动作 */
  group: string
  /** 规则内容：URL（`ruleset=`）或内联规则（`[]GEOIP,CN` / `MATCH`） */
  value: string
  /** 是否为内联规则（`[]` 开头） */
  inline: boolean
}

/** 一个代理组 */
export interface ProxyGroup {
  name: string
  type: string
  /** url-test / fallback / load-balance 用的探测 URL */
  url?: string
  /** 探测间隔（秒） */
  interval?: number
  /** 正则过滤（url-test 的 filter） */
  regex?: string
  /** 成员列表：组名、`DIRECT`、`REJECT` 或 `.*`（通配） */
  members: string[]
}

export interface RouteProfile {
  rules: RouteRule[]
  groups: ProxyGroup[]
}

/**
 * 解析 ini 文本。
 *
 * 容错：无法识别的行静默跳过（ini 是社区维护的，随时可能加新键），
 * 但 `[custom]` 节标记缺失时仍尝试解析 —— 有些导出工具不带节头。
 */
export function parseRouteProfile(text: string): RouteProfile {
  const rules: RouteRule[] = []
  const groups: ProxyGroup[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    // 空行 / 注释 / 节头
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) continue

    if (line.startsWith('ruleset=')) {
      const body = line.slice('ruleset='.length)
      const comma = body.indexOf(',')
      if (comma < 0) continue
      const group = body.slice(0, comma).trim()
      const value = body.slice(comma + 1).trim()
      if (!group || !value) continue
      rules.push({ group, value, inline: value.startsWith('[]') })
      continue
    }

    if (line.startsWith('custom_proxy_group=')) {
      const group = parseProxyGroup(line.slice('custom_proxy_group='.length))
      if (group) groups.push(group)
      continue
    }
    // 其余键（enable_rule_generator 等）忽略
  }

  return { rules, groups }
}

/**
 * 解析 `custom_proxy_group=` 行。
 *
 * 格式（反引号分隔）：
 * ```
 * 组名`类型`[正则`]URL`interval[`成员1`成员2...]
 * ```
 * 例：
 * ```
 * ♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300
 * 🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT`.*
 * 🇭🇰 香港节点`load-balance`(港|HK|hk)`https://captive.apple.com/...`300
 * ```
 *
 * ⚠️ 成员名可能带 `[]` 前缀（subconverter 的「引用已有组」语法），
 * 解析时剥掉 —— 否则 Clash 会去找名为 `[]DIRECT` 的组而失败。
 */
function parseProxyGroup(body: string): ProxyGroup | null {
  const parts = body.split('`')
  const name = (parts[0] ?? '').trim()
  const type = (parts[1] ?? '').trim()
  if (!name || !type) return null

  /** 剥掉成员的 `[]` 前缀 */
  const cleanMember = (raw: string): string => {
    const v = raw.trim()
    return v.startsWith('[]') ? v.slice(2).trim() : v
  }

  const group: ProxyGroup = { name, type, members: [] }

  if (type === 'select') {
    // select`成员1`成员2...
    for (const m of parts.slice(2)) {
      const v = cleanMember(m)
      if (v) group.members.push(v)
    }
    return group
  }

  if (type === 'url-test' || type === 'fallback' || type === 'load-balance') {
    // 类型`[正则`]URL`interval[`成员...]
    let idx = 2
    // 第一段可能是正则（select 通配 `.*`）或 URL
    const first = (parts[idx] ?? '').trim()
    if (first && !/^https?:\/\//i.test(first)) {
      group.regex = first
      idx++
    }
    const url = (parts[idx] ?? '').trim()
    if (/^https?:\/\//i.test(url)) {
      group.url = url
      idx++
    }
    const interval = (parts[idx] ?? '').trim()
    if (/^\d+$/.test(interval)) {
      group.interval = Number(interval)
      idx++
    }
    for (const m of parts.slice(idx)) {
      const v = cleanMember(m)
      if (v) group.members.push(v)
    }
    // 没写成员时给通配（与 subconverter 行为一致）
    if (group.members.length === 0) group.members.push('.*')
    return group
  }

  // 未知类型：把剩余段全当成员，尽量可用
  for (const m of parts.slice(2)) {
    const v = cleanMember(m)
    if (v) group.members.push(v)
  }
  return group
}

/**
 * 把解析出的 profile 渲染成 Clash YAML 的 `rules:` 与 `proxy-groups:` 两段。
 *
 * ## 与 CFPilot 自有订阅的衔接
 *
 * 我们的订阅已经生成了 `proxies:`（节点）和两个基础组
 * （`CFPilot` / `自动选择` / `故障转移`）。ini 里的代理组要**挂到这些节点上**：
 *
 * - ini 里的「节点选择」类组 → 指向 `CFPilot` 组
 * - ini 里的 `♻️ 自动选择`（url-test）→ 已经由我们生成，跳过避免重复
 * - ini 里的国家组（`🇭🇰 香港节点` 等）→ 用其正则过滤我们的节点名
 *
 * @param ourMainGroup 我们订阅里的主策略组名（节点都挂在它下面）
 * @param ourAutoGroup 我们订阅里的自动选择组名（url-test），ini 里有同名则跳过
 */
export function renderRouteProfile(
  profile: RouteProfile,
  options: { mainGroup: string; autoGroup: string; nodeNames: readonly string[] }
): { rules: string[]; groups: string[] } {
  const { mainGroup, autoGroup } = options
  const ruleLines: string[] = []
  const groupLines: string[] = []
  const emitted = new Set<string>()

  // ---- 代理组 ----
  for (const g of profile.groups) {
    if (emitted.has(g.name)) continue

    // 我们已经生成过的组跳过（避免重复定义导致 Clash 报错）。
    //
    // ⚠️ ini 里的组名常带 emoji 前缀（`♻️ 自动选择`），
    // 而我们的组名是干净的（`自动选择`）—— 因此要「去前缀后」比对。
    const bareName = g.name.replace(/^[^\p{L}\p{N}]+/u, '').trim()
    if (bareName === mainGroup || bareName === autoGroup) continue
    if (g.name === mainGroup || g.name === autoGroup) continue

    // 「节点选择」类组跳过：它的成员是 [自动选择, DIRECT, 通配]，
    // 本质上就是我们的主策略组（CFPilot）—— 再生成一份会让订阅里
    // 出现两个等价的 select 组，用户分不清该用哪个。
    //
    // 判定：select 组且成员里含通配 `.*` 或「自动选择」。
    const isMainSelector =
      g.type === 'select' &&
      (g.members.includes('.*') || g.members.some((m) => /自动选择|auto/i.test(m)))
    if (isMainSelector) continue

    emitted.add(g.name)

    groupLines.push(`  - name: ${yamlStr(g.name)}`)
    groupLines.push(`    type: ${yamlStr(g.type)}`)

    if (g.type !== 'select' && g.url) {
      groupLines.push(`    url: ${yamlStr(g.url)}`)
      groupLines.push(`    interval: ${g.interval ?? 300}`)
    }
    if (g.regex && g.regex !== '.*') {
      // Clash 的 filter 是「包含」匹配，不是完整正则；
      // subconverter 的正则里取「或」分支，这里退化为不过滤（交给客户端）。
      // ⚠️ 不做正则→filter 的翻译：误判比不过滤更糟。
    }

    // 成员
    if (g.type === 'select') {
      groupLines.push('    proxies:')
      const members = g.members.map((m) => resolveMember(m, mainGroup, autoGroup))
      // 成员全被解析掉时挂主组，别输出空的 proxies（Clash 会报错）
      if (members.length === 0) {
        groupLines.push(`      - ${yamlStr(mainGroup)}`)
      } else {
        for (const m of members) groupLines.push(`      - ${yamlStr(m)}`)
      }
    } else {
      // url-test / fallback / load-balance：统一挂主组。
      //
      // 为什么不按 ini 的正则挂：Clash 的 filter 是「名称包含」匹配，
      // 而 subconverter 的 `(港|HK|hk)` 是完整正则 —— 直接翻译会把
      // 不该进的节点也拉进来。误判比不过滤更糟，因此交给组内竞速自己挑。
      groupLines.push('    proxies:')
      groupLines.push(`      - ${yamlStr(mainGroup)}`)
    }
  }

  // ---- 分流规则 ----
  for (const r of profile.rules) {
    if (r.inline) {
      // `[]GEOIP,CN` → `GEOIP,CN,<动作>`
      const inner = r.value.slice(2)
      // 动作：组名是「全球直连」类 → DIRECT；否则指向主组
      const action = /直连|direct/i.test(r.group) ? 'DIRECT' : mainGroup
      // FINAL 特殊：MATCH 语义
      if (/^FINAL$/i.test(inner)) {
        ruleLines.push(`  - MATCH,${action}`)
      } else {
        ruleLines.push(`  - ${inner},${action}`)
      }
    } else {
      // 远端 ruleset：Clash 支持 `RULE-SET,<name>,<策略>`
      // name 用 URL 的最后一段（去掉 .list 后缀）
      const name = ruleSetName(r.value)
      const action = /直连|direct/i.test(r.group) ? 'DIRECT' : mainGroup
      ruleLines.push(`  - RULE-SET,${name},${action}`)
    }
  }

  return { rules: ruleLines, groups: groupLines }
}

/** 把 ini 里的成员引用翻译成我们订阅里存在的名字 */
function resolveMember(member: string, mainGroup: string, autoGroup: string): string {
  const m = member.trim()
  if (!m) return mainGroup
  if (m === 'DIRECT' || m === 'REJECT') return m
  if (m === '.*') return mainGroup
  // 指向我们已生成的组
  if (/自动选择|auto/i.test(m)) return autoGroup
  if (/节点选择|proxy|main/i.test(m)) return mainGroup
  // 其余按组名保留（可能是 ini 里定义的其他组）
  return m
}

/** 从 ruleset URL 取一个 Clash `RULE-SET` 可用的名字 */
function ruleSetName(url: string): string {
  const last = url.split('/').pop() ?? url
  return last.replace(/\.(list|txt|yaml|yml)$/i, '') || url
}

/** YAML 字符串：含特殊字符时加双引号 */
function yamlStr(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * 高层入口：解析 ini 文本并渲染成 Clash 订阅的 rules / proxy-groups 段。
 *
 * 供 `renderClash` 在生成订阅尾部调用。KV 里可写 `ROUTE_PROFILE`
 * 覆盖内置配置；传空字符串表示「用内置」。
 *
 * @param text ini 原文（内置的或 KV 覆盖的）
 */
export function renderRouteSections(
  text: string,
  options: { mainGroup: string; autoGroup: string }
): { rules: string[]; groups: string[] } {
  if (!text.trim()) return { rules: [], groups: [] }
  const profile = parseRouteProfile(text)
  return renderRouteProfile(profile, { ...options, nodeNames: [] })
}
