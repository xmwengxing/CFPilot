/**
 * 本地真机验证入口：用 workerd 真实运行**自研数据面**。
 *
 * 目的：验证「VLESS 握手 → 协议解析 → 出站建连 → 数据回传」整条链路，
 * 这是自研数据面唯一还没被证明过的部分（见设计文档 §5「阶段 3 的验证现状」）。
 *
 * 与真实部署的差别：只有 Worker 在本地跑；**出站是真实的 TCP**（workerd 支持
 * `cloudflare:sockets`），目标站是本地明文 HTTP 回显服务器。
 *
 * 端点：
 *   GET /__probe       → Worker 存活探针
 *   GET /__diag        → 最近一次出站的诊断信息（候选顺序、失败原因）
 *   WS  /vl            → 自研数据面入站（VLESS over WebSocket）
 */
import type { Env, UserConfig } from '../../src/types'
import { handleWebSocket } from '../../src/protocols/websocket'
import { collectProxies } from '../../src/routes/data'
import { configFromEnv, mergeConfig } from '../../src/config'
import type { DialFailure } from '../../src/outbound/route'

/** 最近一次出站的诊断（测试用） */
const lastDiag: { failures: DialFailure[]; route?: string } = { failures: [] }

const TEST_UUID = '11111111-2222-3333-4444-555555555555'

function buildConfig(env: Env): UserConfig {
  const base = configFromEnv(env)
  return mergeConfig(base, {
    uuid: TEST_UUID,
    wsPath: '/vl',
    trojanPath: '/tj',
    enableTrojan: true,
    enableXhttp: false,
    // 本地验证开启自动 DoH 解析，验证新链路
    resolvePreferred: true,
  })
}

export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/__probe') {
      return new Response('worker-ok', { status: 200 })
    }

    if (url.pathname === '/__diag') {
      return new Response(
        JSON.stringify(
          {
            uuid: TEST_UUID,
            failures: lastDiag.failures,
            route: lastDiag.route,
          },
          null,
          2
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 反代入口解析诊断：确认内置表能否解析出可用 IP
    if (url.pathname === '/__relay') {
      const { collectRelayEndpoints } = await import('../../src/outbound/relay')
      try {
        const items = await collectRelayEndpoints({
          userEntries: url.searchParams.get('user') || undefined,
          useBuiltin: url.searchParams.get('builtin') !== '0',
        })
        return new Response(
          JSON.stringify({ ok: true, count: items.length, sample: items.slice(0, 8) }, null, 2),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
    }

    // XHTTP 入站（stream-one）
    if (url.pathname === '/xhttp') {
      const { handleXhttp } = await import('../../src/protocols/xhttp')
      const config = buildConfig(env)
      return await handleXhttp(request, config, collectProxies(config))
    }

    if (url.pathname === '/vl') {
      const config = buildConfig(env)
      const upgrade = request.headers.get('Upgrade')?.toLowerCase()
      if (upgrade !== 'websocket') {
        return new Response('需要 WebSocket 升级', { status: 400 })
      }
      // ?proxy=host:port[&proxyKind=socks5|http|https] → 走代理落地
      //
      // ⚠️ `proxyKind=https` 用于验证 `secureTransport:'starttls'` 路径
      // （本地 workerd 不校验证书，能验证协议层正确性）。
      const proxySpec = url.searchParams.get('proxy')
      const proxyKind = url.searchParams.get('proxyKind') ?? 'socks5'
      const effective = proxySpec
        ? {
            ...config,
            socks5: proxyKind === 'socks5' ? proxySpec : '',
            httpProxy: proxyKind === 'http' ? proxySpec : proxyKind === 'https' ? `https://${proxySpec}` : '',
          }
        : config
      lastDiag.failures = []
      const response = await handleWebSocket(
        request,
        'vless',
        effective,
        collectProxies(effective),
        ctx,
        {
          impl: 'self',
          diagnostics: lastDiag,
        }
      )
      return response
    }

    return new Response('CFPilot 自研数据面本地验证', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  },
}
