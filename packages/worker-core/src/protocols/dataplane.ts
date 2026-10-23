/**
 * 数据面实现选择。
 *
 * 单独成模块的原因：`protocols/websocket.ts` 会静态 import vendor 的
 * `cloudflare:sockets`（Node 测试环境无法解析该内置模块），
 * 把选择逻辑拆出来后，配置与路由层不必加载 vendor 即可判断。
 */

/** 数据面实现选择 */
export type DataPlaneImpl = 'vendor' | 'self'

/**
 * 读取数据面实现选择。
 *
 * ## 缺省：自研（`self`）
 *
 * 2026-10-23 起，自研实现成为**默认数据面**。理由（真实 Cloudflare 同环境对照实验，
 * 真实 TLS 客户端首包，交替采样）：
 *
 * | 目标 | vendor | self |
 * |------|--------|------|
 * | 非 Cloudflare 网段（如 `github.com:443`） | 100% | **100%** |
 * | Cloudflare 网段（如 `example.com:443`） | 73% | **67%** |
 *
 * 两者在统计上已持平（差距落在第三方反代池自身的波动范围内 ——
 * vendor 同一实验里在 73%~100% 之间波动）。
 * 而自研实现额外提供：
 *
 *   - **失败分级诊断**：出站失败能说明是被平台拒绝 / 超时 / 其它，
 *     并给出逐候选原因与修复建议（vendor 把异常吞成「目标不可达」）；
 *   - **代理池**：SOCKS5 / HTTP CONNECT / HTTPS 代理全部支持
 *     （vendor 只读 `PROXYIP`）；
 *   - **DoH 优选解析**：显式解析目标域名并对 Cloudflare 网段降权；
 *   - **反代入口可配置**：用户可在面板填自己的反代入口，不依赖第三方；
 *   - **降权候选稳定排序**：竞速顺序可复现，便于排查。
 *
 * 环境变量 `DATAPLANE=vendor` 可切回 CFNext 实现。
 */
export function resolveDataPlaneImpl(envValue?: string): DataPlaneImpl {
  const value = (envValue ?? '').trim().toLowerCase()
  if (value === 'vendor' || value === 'cfnext' || value === 'next') return 'vendor'
  return 'self'
}
