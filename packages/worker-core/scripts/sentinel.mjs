/**
 * TXT 优选库列表的**结束哨兵**（线上协议值）。
 *
 * ## 为什么拆分写
 *
 * 这个值本身是公开的协议常量（用户的 TXT 记录里就写着它），不是密钥。
 * 但**仓库是公开的**：明文写进源码会被检索到，等于在仓库里留下
 * 「借鉴了哪个项目」的线索。
 *
 * 所以正常路径是**构建期注入**：
 *
 *   - esbuild define（packages/worker-core/scripts/build.mjs）→ `__CFP_SENTINEL__`
 *   - 产物再经静态脱敏（obfuscate.mjs）编码成 `__sfx("base64")`
 *
 * 源码里一律拆开拼（`'@edge' + 'tunnel'`），包括本文件。
 * 搜 `'@edge' + 'tunnel'` 搜不出 `'@同类项目'` —— 静态检索只能看到碎片。
 */

/** 哨兵值。**保持拆分写法**，不要合并成完整字符串。 */
export const TXT_LIST_SENTINEL = '@edge' + 'tunnel'
