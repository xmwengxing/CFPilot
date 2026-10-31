#!/usr/bin/env node
/**
 * CFPilot 第一阶段 PoC：**数据面走 Workers、控制面走 Pages**。
 *
 * 用途：在真实账号上跑通「Workers 数据面 + Pages 控制面」这一组合，
 * 验证部署成功、面板可访问、订阅能拿到节点、节点真连接可用。
 *
 * ## 为什么是独立脚本而不是 CLI 子命令
 *
 * 第一阶段只做验证；验证通过后再决定是否接进 CLI / 桌面版
 * （那部分要同时改 GUI、部署向导与文档，不宜和验证混在一起）。
 *
 * ## 分步执行
 *
 *   preflight  只读检查：令牌 / 账号 / zone / workers.dev 子域
 *   smoke      最小 Worker 冒烟（不含任何代理代码）：上传 + 自定义域名 + 可达性
 *   data       数据面：新建 KV + 上传 Worker + 绑自定义域名 + 写 KV 配置
 *   control    控制面：新建 Pages 项目 + 环境变量 + 部署
 *   verify     验收：面板 / 订阅 / 探针 101 / 真实 VLESS 握手
 *   all        preflight → smoke → data → control → verify
 *
 * ## 用法
 *
 *   CFPILOT_TOKEN=cfat_xxx node scripts/deploy-workers-poc.mjs all
 *   CFPILOT_TOKEN=cfat_xxx node scripts/deploy-workers-poc.mjs verify
 *
 * 状态（项目名 / KV / 域名 / 凭据）落在 `tmp/workers-poc/state.json`，
 * 分步执行时后续步骤复用它，不会重复创建资源。
 *
 * ## 联网约定（本机环境的两个坑）
 *
 * 1. **系统 DNS 解析不了 `*.dpdns.org`**（getaddrinfo → ENOTFOUND），
 *    但直连 Cloudflare 边缘 IP 完全正常 → 这里用 DoH 解析后再按 IP 建连，
 *    并把域名作为 SNI（`servername`），TLS 语义不变。
 * 2. DoH 与 API 直连都要走本机代理时，用 `CFPILOT_DOH_PROXY` 指定
 *    （默认 `http://127.0.0.1:10808`）；置空表示直连。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'

const API = 'https://api.cloudflare.com/client/v4'
const TOKEN = process.env.CFPILOT_TOKEN || ''
const ZONE_NAME = process.env.CFPILOT_ZONE || 'dongyao.dpdns.org'
const COMPAT_DATE = process.env.CFPILOT_COMPAT_DATE || '2026-10-01'
const DOH_PROXY = process.env.CFPILOT_DOH_PROXY ?? 'http://127.0.0.1:10808'
const DOH_SERVERS = ['cloudflare-dns.com', 'dns.google']

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const stateDir = resolve(root, 'tmp/workers-poc')
const stateFile = resolve(stateDir, 'state.json')
const distDir = resolve(root, 'packages/worker-core/dist')

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}
function step(title) {
  console.log(`\n=== ${title} ===`)
}
function ok(message) {
  console.log(`✅ ${message}`)
}
function info(message) {
  console.log(`· ${message}`)
}
function warn(message) {
  console.log(`⚠ ${message}`)
}

function loadState() {
  if (!existsSync(stateFile)) return {}
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}
function saveState(state) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

/* ------------------------------------------------------------------ */
/* Cloudflare API（直连可用，不走代理）                                 */
/* ------------------------------------------------------------------ */

async function cf(path, options = {}) {
  const { method = 'GET', body, form, expectEmpty = false } = options
  const headers = { Authorization: `Bearer ${TOKEN}` }
  let payload
  if (form) payload = form
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(90_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${path} → HTTP ${response.status}：${text.slice(0, 600)}`)
  }
  if (expectEmpty || text.trim() === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && parsed.success === false) {
      throw new Error(`${method} ${path} → ${JSON.stringify(parsed.errors)}`)
    }
    return parsed?.result ?? parsed
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${method} ${path}`)) throw err
    return text
  }
}

/** 写 KV 值（values 接口要求 text/plain，不能走 JSON 通道） */
async function putKv(accountId, namespaceId, key, value) {
  const response = await fetch(
    `${API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
      signal: AbortSignal.timeout(60_000),
    }
  )
  if (!response.ok) {
    throw new Error(`写 KV ${key} 失败：HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 网络层：DoH 解析 + 直连 IP 建 TLS                                    */
/* ------------------------------------------------------------------ */

const ipCache = new Map()

/** 通过 HTTP 代理建一条 TLS 连接（代理负责远端 DNS） */
function tlsViaProxy(proxyUrl, host, port, servername, timeoutMs) {
  const proxy = new URL(proxyUrl)
  return new Promise((resolvePromise, rejectPromise) => {
    const raw = net.connect({ host: proxy.hostname, port: Number(proxy.port || 8080) })
    raw.setTimeout(timeoutMs, () => rejectPromise(new Error('代理连接超时')))
    raw.once('error', rejectPromise)
    raw.once('connect', () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      let buf = Buffer.alloc(0)
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        raw.removeListener('data', onData)
        const head = buf.subarray(0, idx).toString('latin1')
        if (!/^HTTP\/1\.[01] 200/.test(head)) {
          raw.destroy()
          rejectPromise(new Error(`代理 CONNECT 失败：${head.slice(0, 120)}`))
          return
        }
        const rest = buf.subarray(idx + 4)
        const socket = tls.connect({ socket: raw, servername })
        socket.once('secureConnect', () => {
          if (rest.length > 0) socket.unshift(rest)
          resolvePromise(socket)
        })
        socket.once('error', rejectPromise)
      }
      raw.on('data', onData)
    })
  })
}

/** 直连某个 IP 建 TLS（SNI 用真实域名） */
function tlsDirect(ip, port, servername, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = tls.connect({ host: ip, port, servername, ALPNProtocols: ['http/1.1'] })
    socket.setTimeout(timeoutMs, () => rejectPromise(new Error(`TLS 连接超时（${ip}:${port}）`)))
    socket.once('secureConnect', () => resolvePromise(socket))
    socket.once('error', rejectPromise)
  })
}

/** 发一个 HTTP/1.1 请求并读完响应 */
function httpRequestOn(socket, host, path, { method = 'GET', extraHeaders = '', timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      rejectPromise(new Error('读取响应超时'))
    }, timeoutMs)

    socket.write(
      `${method} ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `User-Agent: cfpilot-poc/1.0\r\n` +
        `Accept: */*\r\n` +
        `Connection: close\r\n` +
        extraHeaders +
        `\r\n`
    )

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
    socket.once('end', () => {
      clearTimeout(timer)
      try {
        resolvePromise(parseHttpResponse(buf))
      } catch (err) {
        rejectPromise(err)
      }
    })
  })
}

function parseHttpResponse(buf) {
  const idx = buf.indexOf('\r\n\r\n')
  if (idx < 0) throw new Error(`响应头不完整：${buf.subarray(0, 80).toString('latin1')}`)
  const head = buf.subarray(0, idx).toString('latin1')
  let body = buf.subarray(idx + 4)
  const lines = head.split('\r\n')
  const status = Number(lines[0].split(' ')[1])
  const headers = {}
  for (const line of lines.slice(1)) {
    const sep = line.indexOf(':')
    if (sep > 0) headers[line.slice(0, sep).toLowerCase()] = line.slice(sep + 1).trim()
  }
  if ((headers['transfer-encoding'] || '').includes('chunked')) {
    const out = []
    let offset = 0
    while (offset < body.length) {
      const lineEnd = body.indexOf('\r\n', offset)
      if (lineEnd < 0) break
      const size = parseInt(body.subarray(offset, lineEnd).toString('latin1'), 16)
      if (!Number.isFinite(size) || size === 0) break
      out.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
      offset = lineEnd + 2 + size + 2
    }
    body = Buffer.concat(out)
  }
  return { status, headers, body }
}

/** DoH 查询 A 记录（走代理，因为本机系统 DNS 解析不了这些域名） */
async function dohResolve(host) {
  const query = `?name=${encodeURIComponent(host)}&type=A`
  let lastError = null
  for (const server of DOH_SERVERS) {
    // cloudflare-dns.com 用 RFC 8484 的 /dns-query，dns.google 用 /resolve
    const path = `${server === 'dns.google' ? '/resolve' : '/dns-query'}${query}`
    try {
      const socket = DOH_PROXY
        ? await tlsViaProxy(DOH_PROXY, server, 443, server, 15_000)
        : await tlsDirect(server, 443, server, 15_000)
      const response = await httpRequestOn(socket, server, path, {
        extraHeaders: 'Accept: application/dns-json\r\n',
      })
      socket.destroy()
      if (response.status !== 200) throw new Error(`DoH ${server} 返回 ${response.status}`)
      const parsed = JSON.parse(response.body.toString('utf8'))
      const answers = (parsed.Answer || []).filter((a) => a.type === 1).map((a) => a.data)
      if (answers.length > 0) return answers
      throw new Error(`DoH ${server} 无 A 记录`)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`DoH 解析 ${host} 失败：${lastError?.message ?? '未知原因'}`)
}

/** 解析域名 → IPv4 列表（系统 DNS 优先，失败回退 DoH） */
async function resolveIps(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host]
  if (ipCache.has(host)) return ipCache.get(host)
  let ips = []
  try {
    const one = await dns.lookup(host)
    ips = [one.address]
  } catch {
    ips = await dohResolve(host)
  }
  ipCache.set(host, ips)
  return ips
}

/** 对某个域名发 HTTPS 请求（自动 DoH 解析 + 直连 IP） */
async function httpsGet(host, path, options = {}) {
  const { timeoutMs = 20_000 } = options
  const ips = await resolveIps(host)
  let lastError = null
  for (const ip of ips) {
    try {
      const socket = await tlsDirect(ip, 443, host, timeoutMs)
      const response = await httpRequestOn(socket, host, path, { timeoutMs })
      socket.destroy()
      return response
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`${host}${path} 请求失败：${lastError?.message ?? '无可用 IP'}`)
}

/** 轮询直到满足条件 */
async function waitHttp(host, path, { timeoutMs = 120_000, intervalMs = 4000, accept } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      const response = await httpsGet(host, path)
      const body = response.body.toString('utf8')
      last = `HTTP ${response.status} ${body.slice(0, 100).replace(/\s+/g, ' ')}`
      if (accept ? accept(response, body) : response.status === 200) {
        return { status: response.status, body }
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() > deadline) return { status: 0, body: '', last }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket 客户端（手写，便于控制 SNI / 帧）                          */
/* ------------------------------------------------------------------ */

function encodeFrame(payload, opcode = 0x2) {
  const mask = randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  let maskKey = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    maskKey = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  let payload = buffer.subarray(offset, offset + length)
  if (maskKey) {
    const copy = Buffer.from(payload)
    for (let i = 0; i < copy.length; i += 1) copy[i] ^= maskKey[i % 4]
    payload = copy
  }
  return { opcode, payload, size: offset + length }
}

/** 建立 wss 连接并完成 101 握手 */
async function wsConnect(host, path, { timeoutMs = 20_000 } = {}) {
  const ips = await resolveIps(host)
  let lastError = null
  for (const ip of ips) {
    try {
      const socket = await tlsDirect(ip, 443, host, timeoutMs)
      return await wsHandshake(socket, host, path, timeoutMs)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`wss://${host}${path} 连接失败：${lastError?.message ?? '无可用 IP'}`)
}

function wsHandshake(socket, host, path, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    // 每次 readFrame 都会挂一个一次性 error 监听，节点多时容易超过默认上限
    socket.setMaxListeners(0)
    const key = randomBytes(16).toString('base64')
    socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `User-Agent: cfpilot-poc/1.0\r\n\r\n`
    )

    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      rejectPromise(new Error('WS 握手超时'))
    }, timeoutMs)

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx < 0) return
      clearTimeout(timer)
      socket.removeListener('data', onData)
      const head = buffer.subarray(0, idx).toString('latin1')
      const rest = buffer.subarray(idx + 4)
      const status = Number(head.split(' ')[1])
      if (status !== 101) {
        socket.destroy()
        rejectPromise(new Error(`WS 握手未返回 101（实际 ${status}）：${head.slice(0, 160)}`))
        return
      }

      let pending = rest
      const client = {
        status,
        header: head,
        send(data) {
          socket.write(encodeFrame(Buffer.from(data)))
        },
        /** 文本帧（探针的 PING 走文本，二进制会被当成 ArrayBuffer 忽略） */
        sendText(data) {
          socket.write(encodeFrame(Buffer.from(data), 0x1))
        },
        async readFrame() {
          for (;;) {
            const frame = decodeFrame(pending)
            if (frame) {
              pending = pending.subarray(frame.size)
              if (process.env.CFPILOT_DEBUG === '1') {
                console.log(
                  `  [frame] opcode=0x${frame.opcode.toString(16)} len=${frame.payload.length} ` +
                    (frame.opcode === 0x8
                      ? `code=${frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0}`
                      : '')
                )
              }
              if (frame.opcode === 0x8) {
                const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0
                const reason = frame.payload.subarray(2).toString('utf8')
                throw new Error(`对端关闭连接：code=${code} reason=${reason || '(空)'}`)
              }
              if (frame.opcode === 0x9) {
                socket.write(encodeFrame(frame.payload, 0xa))
                continue
              }
              if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
                return frame.payload
              }
              continue
            }
            const chunk = await new Promise((res, rej) => {
              const onChunk = (c) => {
                socket.removeListener('data', onChunk)
                clearTimeout(timer2)
                res(c)
              }
              const timer2 = setTimeout(() => {
                socket.removeListener('data', onChunk)
                rej(new Error('读取帧超时'))
              }, timeoutMs)
              socket.on('data', onChunk)
              socket.once('error', rej)
            })
            pending = Buffer.concat([pending, chunk])
          }
        },
        close() {
          socket.destroy()
        },
      }
      resolvePromise(client)
    }

    socket.on('data', onData)
    socket.once('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
  })
}

/** 构造 VLESS 请求头（version + uuid + addons + command + port + addr） */
function vlessHeader(uuid, host, port) {
  const id = Buffer.from(uuid.replace(/-/g, ''), 'hex')
  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host)
  // ⚠️ 域名类型（0x02）必须带 1 字节长度前缀，否则服务端解析不出主机名
  const addr = isIpv4
    ? Buffer.from(host.split('.').map(Number))
    : Buffer.concat([Buffer.from([Buffer.byteLength(host)]), Buffer.from(host, 'utf8')])
  const header = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + addr.length)
  let o = 0
  header[o++] = 0x00
  id.copy(header, o)
  o += 16
  header[o++] = 0x00
  header[o++] = 0x01
  header.writeUInt16BE(port, o)
  o += 2
  header[o++] = isIpv4 ? 0x01 : 0x02
  addr.copy(header, o)
  return header
}

/* ------------------------------------------------------------------ */
/* 随机值                                                              */
/* ------------------------------------------------------------------ */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomAlnum(length) {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/** 纯随机项目名（不带任何项目特征，与 CLI 的 randomWorkerName 同规则） */
function randomName() {
  const first = 'abcdefghijklmnopqrstuvwxyz'[randomBytes(1)[0] % 26]
  return `${first}${randomAlnum(9)}`
}

/* ------------------------------------------------------------------ */
/* 部署原语                                                            */
/* ------------------------------------------------------------------ */

async function resolveAccount() {
  const accounts = await cf('/accounts')
  const list = Array.isArray(accounts) ? accounts : []
  if (list.length === 0) fail('令牌下没有可访问的账号')
  const wanted = process.env.CFPILOT_ACCOUNT
  const account = wanted ? list.find((a) => a.id === wanted) : list[0]
  if (!account) fail(`找不到账号 ${wanted}`)
  return account
}

async function resolveZone() {
  const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`)
  const zone = (Array.isArray(zones) ? zones : []).find((z) => z.name === ZONE_NAME)
  if (!zone) fail(`账号下找不到 zone ${ZONE_NAME}（自定义域名必需）`)
  return zone
}

/** 上传 ES module 形式的 Worker 脚本 */
async function uploadWorker(accountId, name, code, bindings) {
  const moduleName = 'worker.js'
  const metadata = { main_module: moduleName, compatibility_date: COMPAT_DATE, bindings }
  const form = new FormData()
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
  form.set(moduleName, new Blob([code], { type: 'application/javascript+module' }), moduleName)
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`, { method: 'PUT', form })
}

async function attachWorkerDomain(accountId, zoneId, hostname, service) {
  return await cf(`/accounts/${accountId}/workers/domains`, {
    method: 'PUT',
    body: { hostname, service, zone_id: zoneId, environment: 'production' },
  })
}

async function deployPages(accountId, name, code) {
  const bundle = new FormData()
  bundle.set(
    'metadata',
    new Blob([JSON.stringify({ main_module: '_worker.js', bindings: {} })], { type: 'application/json' }),
    'metadata.json'
  )
  bundle.set('_worker.js', new Blob([code], { type: 'application/javascript+module' }), '_worker.js')
  const bundleRequest = new Request('https://placeholder.invalid', { method: 'POST', body: bundle })

  const form = new FormData()
  form.set('branch', 'main')
  form.set('manifest', '{}')
  form.set(
    '_worker.bundle',
    new Blob([await bundleRequest.arrayBuffer()], {
      type: bundleRequest.headers.get('content-type') ?? 'multipart/form-data',
    }),
    '_worker.bundle'
  )
  return await cf(`/accounts/${accountId}/pages/projects/${name}/deployments`, { method: 'POST', form })
}

async function waitPagesDeployment(accountId, name, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const list = await cf(`/accounts/${accountId}/pages/projects/${name}/deployments`)
    const latest = Array.isArray(list) ? list[0] : null
    last = latest?.latest_stage?.status ?? 'unknown'
    if (last === 'success') return latest
    if (last === 'failure' || last === 'canceled') throw new Error(`Pages 部署失败（状态 ${last}）`)
    if (Date.now() > deadline) throw new Error(`Pages 部署轮询超时（最后状态 ${last}）`)
    await new Promise((r) => setTimeout(r, 4000))
  }
}

/* ------------------------------------------------------------------ */
/* 步骤：preflight                                                     */
/* ------------------------------------------------------------------ */

async function preflight(state) {
  step('preflight：只读检查')
  const account = await resolveAccount()
  state.accountId = account.id
  info(`账号：${account.name}（${account.id}）`)

  const zone = await resolveZone()
  state.zoneId = zone.id
  state.zoneName = zone.name
  ok(`zone：${zone.name}`)

  const sub = await cf(`/accounts/${account.id}/workers/subdomain`)
  state.workersSubdomain = sub?.subdomain ?? ''
  ok(`workers.dev 子域：${state.workersSubdomain || '(未设置)'}`)

  const scripts = await cf(`/accounts/${account.id}/workers/scripts`)
  const names = (Array.isArray(scripts) ? scripts : []).map((s) => s.id)
  info(`现有 Worker 脚本 ${names.length} 个：${names.join(', ') || '(无)'}`)

  saveState(state)
  return state
}

/* ------------------------------------------------------------------ */
/* 步骤：smoke                                                         */
/* ------------------------------------------------------------------ */

const SMOKE_CODE = `export default {
  async fetch() {
    return new Response('smoke-ok ' + new Date().toISOString(), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
}
`

async function smoke(state) {
  step('smoke：最小 Worker 冒烟（不含任何代理代码）')
  if (!state.accountId) await preflight(state)

  const name = state.smokeName || randomName()
  const hostname = state.smokeHost || `s${randomAlnum(8)}.${state.zoneName}`
  state.smokeName = name
  state.smokeHost = hostname
  saveState(state)

  info(`脚本名：${name}`)
  // 幂等：重复执行不重复上传（每次上传都是一次部署，能省则省）
  if (state.smokeUploadedAt && process.env.CFPILOT_FORCE !== '1') {
    info('冒烟脚本已上传过，跳过重复上传（CFPILOT_FORCE=1 可强制重传）')
  } else {
    await uploadWorker(state.accountId, name, SMOKE_CODE, [])
    state.smokeUploadedAt = new Date().toISOString()
    saveState(state)
    ok('脚本上传成功（令牌具备 Workers 写权限）')
  }

  if (!state.smokeDomainId) {
    const domain = await attachWorkerDomain(state.accountId, state.zoneId, hostname, name)
    state.smokeDomainId = domain?.id ?? ''
    saveState(state)
    ok(`已绑定自定义域名 ${hostname}`)
  } else {
    info(`自定义域名已绑定：${hostname}`)
  }

  const hit = await waitHttp(hostname, '/', {
    timeoutMs: 180_000,
    intervalMs: 5000,
    accept: (r, body) => r.status === 200 && body.includes('smoke-ok'),
  })
  if (hit.status !== 200) {
    warn(`自定义域名未在 180s 内生效：${hit.last ?? '无响应'}`)
  } else {
    ok(`自定义域名可达：https://${hostname}/ → ${hit.body.slice(0, 40)}`)
  }
  return state
}

/* ------------------------------------------------------------------ */
/* 步骤：data                                                          */
/* ------------------------------------------------------------------ */

function credentials(state) {
  if (!state.uuid) {
    state.uuid = randomUUID()
    state.trojanPassword = `cfp-${randomAlnum(14)}`
    state.wsPath = `/${randomAlnum(10)}`
    state.panelPath = `/p-${randomAlnum(8)}`
    state.panelPassword = `cfp-${randomAlnum(14)}`
    saveState(state)
  }
  return state
}

async function data(state) {
  step('data：Workers 数据面')
  if (!state.accountId) await preflight(state)
  credentials(state)

  // 1) 独立 KV（一个命名空间 = 一个实例，绝不复用既有 KV）
  if (!state.kvId) {
    const title = `kv-${randomAlnum(10)}`
    const created = await cf(`/accounts/${state.accountId}/storage/kv/namespaces`, {
      method: 'POST',
      body: { title },
    })
    state.kvId = created.id
    state.kvTitle = title
    saveState(state)
    ok(`新建 KV：${title}（${created.id}）`)
  } else {
    info(`复用本次 PoC 的 KV：${state.kvTitle}（${state.kvId}）`)
  }

  // 2) 上传数据面产物（当前 Pages 用的那份，原样对照）
  const codePath = resolve(distDir, 'dataplane.js')
  if (!existsSync(codePath)) fail(`缺少产物 ${codePath}，先跑 npm run build:worker`)
  const code = readFileSync(codePath, 'utf8')

  const name = state.dataName || randomName()
  const hostname = state.dataHost || `w${randomAlnum(8)}.${state.zoneName}`
  state.dataName = name
  state.dataHost = hostname
  saveState(state)

  const bindings = [
    { type: 'kv_namespace', name: 'KV', namespace_id: state.kvId },
    { type: 'plain_text', name: 'UUID', text: state.uuid },
    { type: 'plain_text', name: 'TROJAN_PASSWORD', text: state.trojanPassword },
    { type: 'plain_text', name: 'WS_PATH', text: state.wsPath },
    { type: 'plain_text', name: 'PATH', text: state.wsPath },
    { type: 'plain_text', name: 'ENABLE_TROJAN', text: 'true' },
    { type: 'plain_text', name: 'ENABLE_XHTTP', text: 'true' },
    { type: 'plain_text', name: 'RESOLVE_PREFERRED', text: 'true' },
  ]

  info(`上传数据面 ${name}（${(code.length / 1024).toFixed(1)} KB）`)
  await uploadWorker(state.accountId, name, code, bindings)
  ok('数据面脚本上传成功')

  // 3) 自定义域名（workers.dev 生产域名会被阻断，必须走自有域名）
  if (!state.dataDomainId) {
    const domain = await attachWorkerDomain(state.accountId, state.zoneId, hostname, name)
    state.dataDomainId = domain?.id ?? ''
    saveState(state)
    ok(`已绑定自定义域名 ${hostname}`)
  } else {
    info(`自定义域名已绑定：${hostname}`)
  }

  // 4) 写 KV 配置（内核优先级 KV(CONFIG) > 环境变量 > 默认值）
  await putKv(
    state.accountId,
    state.kvId,
    'CONFIG',
    JSON.stringify({
      uuid: state.uuid,
      trojanPassword: state.trojanPassword,
      wsPath: state.wsPath,
      enableTrojan: true,
      enableXhttp: true,
    })
  )
  ok('KV 配置已写入（uuid / WS 路径 / Trojan 密码）')

  const hit = await waitHttp(hostname, '/', { timeoutMs: 180_000, intervalMs: 5000 })
  if (hit.status === 200) ok(`数据面可达：https://${hostname}/`)
  else warn(`数据面未在 180s 内可达：${hit.last ?? '无响应'}`)

  return state
}

/* ------------------------------------------------------------------ */
/* 步骤：control                                                       */
/* ------------------------------------------------------------------ */

async function control(state) {
  step('control：Pages 控制面')
  if (!state.accountId) await preflight(state)
  if (!state.dataHost) fail('缺少数据面域名，先跑 data 步骤')
  credentials(state)

  const name = state.controlName || randomName()
  state.controlName = name
  saveState(state)

  let project
  try {
    project = await cf(`/accounts/${state.accountId}/pages/projects`, {
      method: 'POST',
      body: { name, production_branch: 'main' },
    })
    ok(`新建 Pages 项目 ${name}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(message)) throw err
    project = await cf(`/accounts/${state.accountId}/pages/projects/${name}`)
    info(`Pages 项目 ${name} 已存在，复用`)
  }
  state.controlSubdomain = project?.subdomain ?? `${name}.pages.dev`

  // 变量与 KV 必须在部署前配置，否则对本次部署不生效
  await cf(`/accounts/${state.accountId}/pages/projects/${name}`, {
    method: 'PATCH',
    body: {
      deployment_configs: {
        production: {
          kv_namespaces: {
            KV: { namespace_id: state.kvId },
            K: { namespace_id: state.kvId },
          },
          env_vars: {
            PANEL_PATH: { value: state.panelPath },
            PANEL_PASSWORD: { value: state.panelPassword },
            DATA_HOST: { value: state.dataHost },
          },
        },
      },
    },
  })
  ok(`已配置环境变量（DATA_HOST=${state.dataHost}）`)

  const codePath = resolve(distDir, 'control.js')
  if (!existsSync(codePath)) fail(`缺少产物 ${codePath}，先跑 npm run build:worker`)
  const code = readFileSync(codePath, 'utf8')
  info(`上传控制面（${(code.length / 1024).toFixed(1)} KB）`)
  await deployPages(state.accountId, name, code)
  const deployment = await waitPagesDeployment(state.accountId, name)
  state.controlDeploymentId = deployment?.id ?? ''
  saveState(state)
  ok(`控制面部署成功：${state.controlSubdomain}`)
  return state
}

/* ------------------------------------------------------------------ */
/* 步骤：verify                                                        */
/* ------------------------------------------------------------------ */

async function verify(state) {
  step('verify：验收')
  if (!state.controlSubdomain || !state.dataHost) fail('缺少控制面/数据面域名，先跑 control 步骤')

  const results = []
  const record = (name, pass, detail) => {
    results.push({ name, pass, detail })
    if (pass) ok(`${name}：${detail}`)
    else warn(`${name}：${detail}`)
  }

  // 1) 面板
  const panel = await waitHttp(state.controlSubdomain, state.panelPath, {
    timeoutMs: 90_000,
    accept: (r, body) => r.status === 200 && /<html/i.test(body),
  })
  record(
    '面板可访问',
    panel.status === 200,
    `https://${state.controlSubdomain}${state.panelPath} → ${panel.status}`
  )

  // 2) 订阅
  const sub = await waitHttp(state.controlSubdomain, `/sub/${state.uuid}`, { timeoutMs: 60_000 })
  let nodeText = sub.body
  if (sub.status === 200) {
    const compact = nodeText.replace(/\s+/g, '')
    if (!compact.includes('://')) {
      try {
        nodeText = Buffer.from(compact, 'base64').toString('utf8')
      } catch {
        /* 保持原文 */
      }
    }
  }
  const nodeCount = (nodeText.match(/:\/\//g) || []).length
  const hostOk = nodeText.includes(state.dataHost)
  record('订阅可拉取', sub.status === 200 && nodeCount > 0, `${sub.status}，节点 ${nodeCount} 条`)
  record('节点域名指向数据面', hostOk, hostOk ? state.dataHost : `订阅里没有 ${state.dataHost}`)

  // 3) 探针 WS 101
  let probeOk = false
  let probeDetail = ''
  try {
    const ws = await wsConnect(state.dataHost, '/__edge_probe')
    ws.sendText('PING')
    const payload = await ws.readFrame()
    probeDetail = payload.toString('utf8').slice(0, 160)
    probeOk = probeDetail.includes('pong')
    ws.close()
  } catch (err) {
    probeDetail = err instanceof Error ? err.message : String(err)
  }
  record('探针 WS 101 握手', probeOk, probeDetail)

  // 4) 真实 VLESS 握手 + 取数据
  const targetHost = process.env.CFPILOT_TEST_HOST || 'www.gstatic.com'
  const targetPort = Number(process.env.CFPILOT_TEST_PORT || 80)
  const targetPath = process.env.CFPILOT_TEST_PATH || '/generate_204'
  let vlessOk = false
  let vlessDetail = ''
  const started = Date.now()
  try {
    const ws = await wsConnect(state.dataHost, state.wsPath)
    const request = Buffer.from(
      `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: curl/8.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      'utf8'
    )
    ws.send(Buffer.concat([vlessHeader(state.uuid, targetHost, targetPort), request]))

    let response = Buffer.alloc(0)
    let firstByteMs = 0
    for (let i = 0; i < 8; i += 1) {
      let frame
      try {
        frame = await ws.readFrame()
      } catch (err) {
        // 对端在数据发完后会主动 close（1000 done）—— 已收到的字节仍然有效
        if (response.length > 0) break
        throw err
      }
      if (firstByteMs === 0) firstByteMs = Date.now() - started
      response = Buffer.concat([response, frame])
      if (response.length > 8000) break
    }
    ws.close()

    const addonLen = response[1] ?? 0
    const body = response.subarray(2 + addonLen)
    const text = body.toString('utf8')
    vlessOk = /^HTTP\/1\.[01] (200|204|301|302)/.test(text)
    vlessDetail = `${firstByteMs}ms 首字节，共 ${response.length}B，${text.slice(0, 90).replace(/\s+/g, ' ')}`
  } catch (err) {
    vlessDetail = err instanceof Error ? err.message : String(err)
  }
  record('真实 VLESS 连接', vlessOk, vlessDetail)

  // 5) 吞吐（信息项，不计入通过条件 —— 测速站点本身可能不可达）
  const speedHost = process.env.CFPILOT_SPEED_HOST || 'cachefly.cachefly.net'
  const speedPath = process.env.CFPILOT_SPEED_PATH || '/1mb.test'
  try {
    const ws = await wsConnect(state.dataHost, state.wsPath)
    const request = Buffer.from(
      `GET ${speedPath} HTTP/1.1\r\nHost: ${speedHost}\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n`,
      'utf8'
    )
    ws.send(Buffer.concat([vlessHeader(state.uuid, speedHost, 80), request]))
    const begin = Date.now()
    let bytes = 0
    for (;;) {
      if (bytes > 300_000 || Date.now() - begin > 20_000) break
      let frame
      try {
        frame = await ws.readFrame()
      } catch {
        break
      }
      bytes += frame.length
    }
    ws.close()
    const seconds = Math.max((Date.now() - begin) / 1000, 0.001)
    const kbps = (bytes / 1024 / seconds).toFixed(0)
    info(`吞吐（信息项）：${(bytes / 1024).toFixed(0)} KB / ${seconds.toFixed(1)}s ≈ ${kbps} KB/s`)
  } catch (err) {
    info(`吞吐测试跳过：${err instanceof Error ? err.message : String(err)}`)
  }

  const passed = results.filter((r) => r.pass).length
  console.log(`\n验收结果：${passed}/${results.length} 通过`)
  if (passed !== results.length) {
    console.log('未通过项：')
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}：${r.detail}`)
  }
  state.verify = { at: new Date().toISOString(), passed, total: results.length, results }
  saveState(state)
  return results
}

/* ------------------------------------------------------------------ */
/* 步骤：cleanup（只清理冒烟资源，保留验收实例）                        */
/* ------------------------------------------------------------------ */

async function cleanup(state) {
  step('cleanup：清理冒烟资源（保留验收实例）')
  if (!state.accountId) fail('缺少 accountId')

  if (state.smokeDomainId) {
    try {
      await cf(`/accounts/${state.accountId}/workers/domains/${state.smokeDomainId}`, {
        method: 'DELETE',
        expectEmpty: true,
      })
      ok(`已解绑冒烟自定义域名 ${state.smokeHost}`)
    } catch (err) {
      warn(`解绑冒烟域名失败：${err instanceof Error ? err.message : String(err)}`)
    }
    delete state.smokeDomainId
    saveState(state)
  }

  if (state.smokeName) {
    try {
      await cf(`/accounts/${state.accountId}/workers/scripts/${encodeURIComponent(state.smokeName)}`, {
        method: 'DELETE',
        expectEmpty: true,
      })
      ok(`已删除冒烟脚本 ${state.smokeName}`)
    } catch (err) {
      warn(`删除冒烟脚本失败：${err instanceof Error ? err.message : String(err)}`)
    }
    delete state.smokeName
    delete state.smokeHost
    delete state.smokeUploadedAt
    saveState(state)
  }

  info(`保留实例：数据面 ${state.dataHost}（${state.dataName}） / 控制面 ${state.controlSubdomain}`)
  return state
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  if (!TOKEN) fail('缺少 CFPILOT_TOKEN 环境变量')
  const command = process.argv[2] || 'all'
  const state = loadState()

  try {
    if (command === 'preflight') await preflight(state)
    else if (command === 'smoke') await smoke(state)
    else if (command === 'data') await data(state)
    else if (command === 'control') await control(state)
    else if (command === 'verify') await verify(state)
    else if (command === 'cleanup') await cleanup(state)
    else if (command === 'all') {
      await preflight(state)
      await smoke(state)
      await data(state)
      await control(state)
      await verify(state)
    } else {
      fail(
        `未知步骤 ${command}（可用：preflight / smoke / data / control / verify / cleanup / all）`
      )
    }
  } catch (err) {
    console.error(`\n✗ 执行失败：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }

  console.log('\n--- 本次状态 ---')
  console.log(JSON.stringify(loadState(), null, 2))
}

main()
