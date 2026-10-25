/**
 * Pages 域名规整（纯函数，不依赖 electron / Node API）。
 *
 * 单独成文件的原因：要能被单元测试直接 import。
 * `bridge.ts` 会 import electron，测试环境跑不起来。
 */

/**
 * 规整 Pages 域名为**恰好一个** `.pages.dev` 后缀。
 *
 * ## 为什么需要（2026-10-25 用户反馈的真 bug）
 *
 * Cloudflare 的 `project.subdomain` 字段在不同 API 版本 / 不同项目下
 * 取值形态不一致：
 *
 *   - 老项目：`cpdata`                       （纯名字）
 *   - 新项目：`cpdata.pages.dev`             （已带后缀）
 *   - 少数情况：`cpdata.pages.dev.pages.dev` （历史数据被污染）
 *
 * 早年代码无条件拼 `${subdomain}.pages.dev`，遇到第二种就变成
 * `cpdata.pages.dev.pages.dev` —— 这个域名**不存在**，拿去优选必然全失败。
 *
 * 这里统一：去掉所有 `.pages.dev` 后缀，再补一次。
 *
 * @param subdomain 原始值（可能为空，可能带协议或尾部斜杠）
 * @returns 形如 `name.pages.dev` 的域名；无可提取的名字时返回空串
 */
export function normalizePagesHost(subdomain: string | undefined | null): string {
  const raw = (subdomain ?? '').trim().toLowerCase()
  if (!raw) return ''
  // 去掉协议前缀（少数情况会带 https://）
  const bare = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  // 反复剥离所有尾部 .pages.dev
  let name = bare
  while (name.endsWith('.pages.dev')) {
    name = name.slice(0, -'.pages.dev'.length)
  }
  return name ? `${name}.pages.dev` : ''
}
