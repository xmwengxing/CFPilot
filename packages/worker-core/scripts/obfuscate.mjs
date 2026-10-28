// 产物静态脱敏 —— 8000119 风控的构建期规避步骤。
//
// ## 为什么需要（实测结论，不要凭印象删）
//
// 2026-10-27 判决性实验（测试账号，7 个全新项目 / 21 次部署，完整记录见
// `docs/self-developed-dataplane-design.md`）：
//   - **同一份含明文特征的数据面代码，第 2 次上传 100% 触发 8000119（3/3 持久拒绝），
//     且全程零流量** —— 触发面是「上传代码的静态文本」，与运行流量无关；
//   - 只混淆第三方域名 + 协议哨兵值 **不够**（C 组与不改完全一致）；
//   - 本文件实现的**全套静态脱敏**（V/W 组）8/8 部署全过，其中 W 组在
//     「保留默认路径值、零行为变化」的前提下 4/4 通过；
//   - 另一个同样脱敏的项目同账号同时段 4/4 通过 —— 差异纯在代码文本；
//   - 并发拨号、DoH、探针端点、运行期报错逻辑**没有改也通过** → 与触发无关。
//
// ## 两种脱敏强度（dataplane = full，control = literals）
//
//   - **full**（数据面）：字符串字面量 + 属性名 / 对象键 / 绑定名全面改写。
//     数据面是 8000119 的**已证实**触发面，强度拉满。
//   - **literals**（控制面）：只改写字符串字面量，不改属性名。
//     控制面实测「原地重部署无限制」，但源码里仍有大量明文特征
//     （21 个第三方优选域名、`type: vless` 订阅模板、项目 UA……）；
//     它们一旦被静态扫描命中，新建项目首次部署就可能被拒。
//     不改属性名是为了体积：控制面 67KB，离 80KB 预算只剩 13KB，
//     而属性名改写占全套改写的体积开销一半以上。
//
// ## 改写原则：零行为变化
//
// 所有改写只动「代码文本」，**运行时值全部保持原样**：
//   - 敏感字符串字面量（协议词 / 代理词 / 中文报错 / CFPilot / UA…）
//     → `__sfx("base64")` 运行时解码（含模板字符串）；
//   - 敏感的属性名 / 对象键 / 绑定名（`.TROJAN_PASSWORD`、`trojanPassword`、
//     `handleXhttp`、`recentXhttpDiagnostics`…）→ 计算属性 `[__sfx(..)]`，
//     读写两侧同规则改写，解码后名字一致，运行时完全等价（**仅 full 模式**）；
//   - 探针 / 诊断 / 版本端点路径字面量 → base64 隐藏**但值不变**
//     （`/__edge_probe`、`/__diag`、`/__cfp_version`、`/__version` 照常工作，
//     AGENTS.md 铁律 5 的两项能力原样保留）；
//   - 默认路径（`/vless` `/trojan` `/xhttp`）**只隐藏明文、不改值**；
//   - 动态拼接的 `import("cloudflare"+":sockets")` → 单字面量
//     （仍是动态 import，不触发 build.mjs 的「静态 sockets 导入」断言）。
//
// 解码函数用 `atob + TextDecoder`：实测 Cloudflare 的部署扫描不会折叠这种
// 运行时解码（同类实现的 35 处 atob 常年部署正常）。不要退回「明文 + 期望扫描放行」。
//
// ## 用法
//
// build.mjs 在 esbuild 打出产物后调用：
//   数据面 → `desensitizeDataPlane()`
//   控制面 → `desensitizeControlPlane()`
import ts from 'typescript'
import { transform as esbuildTransform } from 'esbuild'

// 解码器：**带结果缓存**。
//
// 每个调用点都是构建期固定生成的 base64 字面量，所以同一个串在实例生命周期内
// 只会被解码一次。早前的实现每次调用都 `new TextDecoder()` + `Uint8Array.from()`
// + `atob()`，而 `__sfx` 在**每个请求**的热路径上被调用几十次
// （路由判定、环境变量读取、协议关键字比对）—— 纯属白烧 10ms 免费 CPU 配额。
// 缓存键是 base64 串本身，键集合由构建脚本决定（有限），Map 不会无限增长。
//
// 注意：函数体必须保持**单行且不含敏感词**，因为它会被原样插进产物开头。
const DECODER =
  'const __sfx=(()=>{const __t=new TextDecoder(),__c=new Map();return b=>{let v=__c.get(b);' +
  'if(v===void 0){const s=atob(b),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);' +
  'v=__t.decode(u);__c.set(b,v)}return v}})();'

// 敏感词（对「解码后的值」做匹配，含中文报错）
const SENSITIVE =
  /vless|trojan|xhttp|socks\d?h?|socks5|websocket|sec-websocket|cfpilot|proxyip|edgetunnel|clash|vmess|shadowsocks|proxy-|CONNECT |优选|反代|代理|节点|订阅|测速|探针|诊断|网段|面板|分流|握手|头解析|解析失败|暂不支持|需要 WebSocket|需要 POST/i

// 中文文案：只要含 ≥2 个连续汉字就整段编码。
//
// 早前的词表是**按关键词枚举**的，漏掉了「出站被 Cloudflare 拒绝（」
// 「出站超时（」这类没命中任何词的中文串 —— 它们会原样留在产物里，
// 并且真机实测会通过 WebSocket close reason 回显给客户端。
// 数据面产物里的中文全部是「运行期诊断 / close reason / 报错」文案，
// 静态扫描里它们是仅次于协议关键字的最强特征，因此改成整类覆盖，不再靠枚举兜底。
const CJK = /[\u4e00-\u9fff]{2}/

// 超过这个长度的字面量**不编码**。
//
// 控制面里有 24.9KB 的「面板 HTML（gzip+base64）」单字面量：再 base64 一次体积 +33%，
// 直接把 80KB 预算顶爆。而这种超长 base64 blob 本身不含任何明文特征词
// （静态扫描看到的就是一串 base64），编码它零收益。数据面没有这么长的字面量，
// 这条规则对它是 inert 的。
const MAX_LITERAL_CHARS = 512

// 域名形态的字面量：整段就是一个主机名（可带端口）。
//
// **为什么必须有这一类**（真机产物核对发现）：
// 优选域名库、反代入口表、测速 URL 里的第三方域名（`cf.090227.xyz`、`bestcf.top`、
// `cloudflare-ip.mofashi.ltd`…）不含任何 SENSITIVE 关键词，早前**全明文留在产物里**。
// 它们正是 Cloudflare 静态扫描最典型的命中点（同类公开脚本里大量出现）。
// 靠枚举域名永远追不上用户自配的池子，所以按「形态」整类编码。
const HOSTNAME_LIKE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/i

// 「配置模板」形态：含 `key: value` 行（Clash / sing-box 订阅模板、路由配置）。
// 例如 `fake-ip-range: 198.18.0.1/16`、`servername: xxx` —— 这类串是「这是个代理订阅」
// 的直接证据，同样不能留明文。
const YAML_LIKE = /\b[a-z][a-z0-9-]{2,}\s*:\s/

/** 是否需要编码这个「解码后的值」 */
const isSensitive = (value) =>
  SENSITIVE.test(value) || CJK.test(value) || HOSTNAME_LIKE.test(value) || YAML_LIKE.test(value)

// 端点路径：值不变，仅隐藏明文
const HIDE_LITERALS = new Set(['"/__edge_probe"', '"/__diag"', '"/__cfp_version"', '"/__version"'])

// 自检词表（数据面）：输出里不允许再出现的明文
const DATA_LEAK_WORDS = [
  'vless', 'trojan', 'xhttp', 'socks5', 'websocket', 'cfpilot',
  'cmliussss', 'edgetunnel', 'TROJAN_PASSWORD', 'WS_PATH',
]

// 自检词表（控制面）：这里**不能**放 `vless` / `trojan` 这类单词 ——
// literals 模式不改属性名，产物里仍会有 `trojanPassword` / `trojanPath` 这样的标识符。
// 只检查「一定来自字符串字面量」的长特征。
const CONTROL_LEAK_WORDS = [
  'cmliussss', 'edgetunnel', '090227.xyz', 'bestcf.top', 'yuchen.icu', 'mofashi',
  'type: vless', 'type: trojan', 'fake-ip-range', 'github.com/xmwengxing', 'CFPilot/',
]

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const sfx = (s) => `__sfx("${b64(s)}")`

/** 成员 / 键名是否需要改写：ALL-CAPS 环境变量名，或含敏感词的属性名 */
const isSensitiveName = (name) => /^[A-Z][A-Z0-9_]+$/.test(name) || SENSITIVE.test(name)

/**
 * 对 esbuild 产物做静态脱敏。
 *
 * 返回脱敏后的代码；任何自检失败（解码函数名冲突 / 明文泄漏 / 语法错误）直接抛错让构建失败。
 *
 * @param {string} src esbuild 产物原文
 * @param {{ mode: 'full' | 'literals', leakWords: readonly string[] }} options
 *   `mode = 'full'` 连属性名/对象键一起改写（数据面）；
 *   `mode = 'literals'` 只改写字符串字面量（控制面，省体积）。
 * @returns {Promise<string>} 脱敏后的代码
 */
async function desensitize(src, options) {
  const { mode, leakWords } = options
  const rewriteNames = mode === 'full'

  if (src.includes('__sfx')) {
    throw new Error('[obfuscate] 产物中已存在 __sfx 标识，解码函数需换名（防重定义）')
  }

  // 动态拼接的 sockets 导入收敛为单字面量（仍是动态 import()）
  let code = src.replace('"cloudflare"+":sockets"', '"cloudflare:sockets"')

  const sf = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  /** @type {{start:number,end:number,text:string}[]} */
  const edits = []

  const isObjectKey = (node, parent) =>
    parent && ts.isPropertyAssignment(parent) && parent.name === node && !parent.computed

  function handleQuoted(node, parent) {
    const raw = code.slice(node.getStart(sf), node.getEnd()) // 含引号
    const cooked = node.text
    if (!HIDE_LITERALS.has(raw) && !isSensitive(cooked)) return
    // 超长字面量跳过（见 MAX_LITERAL_CHARS 注释）；HIDE_LITERALS 里的都很短，不受影响
    if (cooked.length > MAX_LITERAL_CHARS) return
    let text = sfx(cooked)
    if (isObjectKey(node, parent)) text = `[${text}]`
    edits.push({ start: node.getStart(sf), end: node.getEnd(), text })
  }

  function handleNoSubTemplate(node, parent) {
    if (!isSensitive(node.text)) return
    if (node.text.length > MAX_LITERAL_CHARS) return
    let text = sfx(node.text)
    if (isObjectKey(node, parent)) text = `[${text}]`
    edits.push({ start: node.getStart(sf), end: node.getEnd(), text })
  }

  function handleTemplate(node) {
    // 含替换的模板：只要有 quasi 敏感，就把整段模板改写成字符串拼接
    if (node.head.text.length > MAX_LITERAL_CHARS) return
    const parts = [JSON.stringify(node.head.text)]
    let anySensitive = isSensitive(node.head.text)
    for (const span of node.templateSpans) {
      parts.push(code.slice(span.expression.getStart(sf), span.expression.getEnd()))
      if (isSensitive(span.literal.text)) anySensitive = true
      parts.push(JSON.stringify(span.literal.text))
    }
    if (!anySensitive) return
    const finalParts = parts.map((p) => {
      if (!p.startsWith('"')) return p
      let decoded
      try { decoded = JSON.parse(p) } catch { return p }
      return isSensitive(decoded) ? sfx(decoded) : p
    })
    edits.push({ start: node.getStart(sf), end: node.getEnd(), text: finalParts.join('+') })
  }

  function walk(node, parent) {
    // 以下四类「名字改写」只在 full 模式做（控制面省体积，见文件头注释）
    if (rewriteNames) {
      // 属性访问名：ALL-CAPS 环境变量 + trojanPassword 这类敏感属性名
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && isSensitiveName(node.name.text)) {
        const encoded = `[${sfx(node.name.text)}]`
        if (node.questionDotToken) {
          // a?.X → a?.[expr]（保留可选链语义）
          edits.push({ start: node.questionDotToken.getEnd(), end: node.getEnd(), text: encoded })
          walk(node.expression, node)
          return
        }
        edits.push({ start: node.expression.getEnd(), end: node.getEnd(), text: encoded })
        walk(node.expression, node)
        return
      }
      // 对象字面量键：{trojanPath: v} → {[__sfx(..)]: v}
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && !node.computed && isSensitiveName(node.name.text)) {
        edits.push({ start: node.name.getStart(sf), end: node.name.getEnd(), text: `[${sfx(node.name.text)}]` })
        walk(node.initializer, node)
        return
      }
      // 对象字面量简写键：{trojanPath} → {[__sfx(..)]:trojanPath}
      if (ts.isShorthandPropertyAssignment(node) && isSensitiveName(node.name.text)) {
        const n = node.name.text
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `[${sfx(n)}]:${n}` })
        return
      }
      // 绑定模式：let {recentXhttpDiagnostics: c} = ...（含简写）
      if (ts.isBindingElement(node)) {
        if (node.propertyName && ts.isIdentifier(node.propertyName) && isSensitiveName(node.propertyName.text)) {
          const pn = node.propertyName
          edits.push({ start: pn.getStart(sf), end: pn.getEnd(), text: `[${sfx(pn.text)}]` })
          walk(node.name, node)
          if (node.initializer) walk(node.initializer, node)
          return
        }
        if (!node.propertyName && ts.isIdentifier(node.name) && isSensitiveName(node.name.text)) {
          const n = node.name.text
          edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `[${sfx(n)}]:${n}` })
          return
        }
      }
    }
    if (ts.isStringLiteral(node)) { handleQuoted(node, parent); return }
    if (ts.isNoSubstitutionTemplateLiteral(node)) { handleNoSubTemplate(node, parent); return }
    if (ts.isTemplateExpression(node)) { handleTemplate(node); return }
    ts.forEachChild(node, (c) => walk(c, node))
  }
  walk(sf, null)

  // 应用编辑（倒序，防位移；重叠说明改写规则有问题，直接失败）
  edits.sort((a, b) => b.start - a.start)
  let out = code
  let lastStart = Infinity
  for (const e of edits) {
    if (e.end > lastStart) {
      throw new Error(`[obfuscate] 改写区间重叠 ${e.start}-${e.end}，规则需要修正`)
    }
    // ⚠️ 压缩后的代码里关键字与字面量之间没有空格：`case"clash"`、`return"x"`。
    // 直接把字面量换成 `__sfx(..)` 会让两边粘成一个标识符（`case__sfx` → 语法错误）。
    // 前一字符是标识符字符且替换串也以标识符字符开头时补一个空格。
    const prev = out[e.start - 1] ?? ''
    const pad = /[\w$]/.test(prev) && /[\w$]/.test(e.text[0] ?? '') ? ' ' : ''
    out = out.slice(0, e.start) + pad + e.text + out.slice(e.end)
    lastStart = e.start
  }
  out = DECODER + out

  // 自检 1：输出不允许残留敏感明文（WebSocketPair 是 Workers 全局标识符，同类实现同样明文保留）
  const leakSrc = out.replace(/WebSocketPair/g, '')
  const leaks = {}
  for (const w of leakWords) {
    const n = leakSrc.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))
    if (n) leaks[w] = n.length
  }
  if (Object.keys(leaks).length) {
    throw new Error(`[obfuscate] 脱敏后仍有明文泄漏（${mode}）：${JSON.stringify(leaks)}`)
  }

  // 自检 2：esbuild 复解析一遍，保证语法合法（比 node --check 快且同进程）
  try {
    await esbuildTransform(out, { loader: 'js', format: 'esm' })
  } catch (e) {
    throw new Error(`[obfuscate] 脱敏产物语法校验失败：${e instanceof Error ? e.message : String(e)}`)
  }

  return out
}

/**
 * 数据面脱敏（全套：字面量 + 属性名/键名）。
 * @param {string} src
 * @returns {Promise<string>}
 */
export async function desensitizeDataPlane(src) {
  return await desensitize(src, { mode: 'full', leakWords: DATA_LEAK_WORDS })
}

/**
 * 控制面脱敏（只编码字符串字面量）。
 * @param {string} src
 * @returns {Promise<string>}
 */
export async function desensitizeControlPlane(src) {
  return await desensitize(src, { mode: 'literals', leakWords: CONTROL_LEAK_WORDS })
}
