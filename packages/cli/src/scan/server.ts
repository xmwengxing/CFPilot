/**
 * 本地 Loopback 桥接服务
 *
 * 在 127.0.0.1:19527 上提供：
 *   GET  /status      面板探测用
 *   POST /start-scan  下发扫描任务
 *   GET  /events      SSE 实时进度
 *   GET  /results     最近一次结果
 *
 * 只监听回环地址，且开启 CORS 以便面板网页跨域调用。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { formatEntries, runScan, type ScanEvent, type ScanEntry } from './scan'
import { postResults } from './callback'
import {
  DEFAULT_BRIDGE_SAMPLE,
  DEFAULT_CANDIDATE_SAMPLE,
  normalizeCandidateList,
  resolveCandidates,
  type IpFamily,
} from './candidates'

export const BRIDGE_VERSION = '0.2.0'
export const DEFAULT_BRIDGE_PORT = 19527

/**
 * POST /start-scan 请求体（面板「一键优选」与命令行手写请求共用）
 *
 * 候选来源优先级：manual > candidates > 自动生成（sample / cidr / seed）。
 * 面板当前不传 candidates，因此服务端必须能自行生成，否则一键优选必然失败。
 */
export interface StartScanRequest {
  /** Worker 自定义域名（TLS SNI 与 HTTP Host） */
  host: string
  /** 端口，默认 443 */
  port?: number
  /** 回填一次性令牌 */
  token?: string
  /** 回填地址，默认同 host 的 /api/v1/preferred-ips */
  callback?: string
  /** 最终返回条数，默认 15 */
  top?: number
  /** 面板手动优选 IP（优先于 candidates 与自动生成），支持 IP / IP:Port / IP:Port#备注 */
  manual?: string[]
  /** 显式候选 IP 列表；为空时由服务端自动生成 */
  candidates?: string[]
  /** 自动生成候选时的采样数，默认 300 */
  sample?: number
  /** 自动生成候选时使用的自定义网段（字符串或数组，逗号分隔亦可） */
  cidr?: string | string[]
  /** 自动生成候选时的随机种子，默认 24301（相同种子结果可复现） */
  seed?: number
  /** 自动生成候选时的地址族，默认 both */
  family?: IpFamily
  /** 国家 / 地区过滤（可多选，如 ["HK","JP"]；空 / 不传 = 全量） */
  countries?: string[]
}

/** 候选来源：手动指定 / 请求显式携带 / 服务端自动生成 */
export type CandidateSource = 'manual' | 'request' | 'generated'

export interface CandidatePlan {
  candidates: string[]
  source: CandidateSource
}

/** 采样数兜底：非正数或非法值回落到默认值，并限制上限避免一次拉爆候选量 */
function normalizeSample(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), DEFAULT_CANDIDATE_SAMPLE)
  }
  return DEFAULT_BRIDGE_SAMPLE
}

/** 规范化种子：非法值交给候选模块使用默认种子 */
function normalizeSeed(value: number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return undefined
}

function normalizeFamily(value: IpFamily | undefined): IpFamily | undefined {
  return value === 'v4' || value === 'v6' || value === 'both' ? value : undefined
}

/**
 * 解析候选来源：manual > candidates > 自动生成。
 *
 * 自动生成复用 candidates.ts（与 CLI 同一套逻辑），因此面板不传 candidates 也能扫。
 */
export async function resolveScanCandidates(body: StartScanRequest): Promise<CandidatePlan> {
  const manual = normalizeCandidateList(body.manual)
  if (manual.length > 0) return { candidates: manual, source: 'manual' }

  const requested = normalizeCandidateList(body.candidates)
  if (requested.length > 0) return { candidates: requested, source: 'request' }

  const candidates = await resolveCandidates({
    sample: normalizeSample(body.sample),
    cidr: body.cidr,
    seed: normalizeSeed(body.seed),
    family: normalizeFamily(body.family),
  })
  return { candidates, source: 'generated' }
}

/** 生成进度文案（面板会把 message 打到扫描日志里） */
function describePlan(plan: CandidatePlan): string {
  if (plan.source === 'manual') return `使用面板手动指定的 ${plan.candidates.length} 个候选 IP`
  if (plan.source === 'request') return `使用请求携带的 ${plan.candidates.length} 个候选 IP`
  return `已自动生成 ${plan.candidates.length} 个候选 IP`
}

interface Job {
  id: string
  startedAt: number
  events: ScanEvent[]
  subscribers: Set<import('node:stream').Writable>
  result: ScanEntry[]
  finished: boolean
}

export interface BridgeHandle {
  server: Server
  port: number
  close(): Promise<void>
}

const jobs = new Map<string, Job>()
let jobCounter = 0

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析 /start-scan 请求体：必须是 JSON 对象 */
function parseStartScanRequest(text: string): StartScanRequest | null {
  try {
    const raw: unknown = JSON.parse(text || '{}')
    if (typeof raw !== 'object' || raw === null) return null
    return raw as StartScanRequest
  } catch {
    return null
  }
}

function eventToSse(event: ScanEvent): string {
  switch (event.type) {
    case 'stage':
      return `event: stage\ndata: ${JSON.stringify({ stage: event.stage, name: event.name, total: event.total })}\n\n`
    case 'progress':
      return `event: progress\ndata: ${JSON.stringify({
        stage: event.stage,
        done: event.done,
        total: event.total,
        percent: event.total > 0 ? Math.round((event.done / event.total) * 100) : 0,
        message: event.message,
      })}\n\n`
    case 'result':
      return `event: result\ndata: ${JSON.stringify({ entry: event.entry })}\n\n`
    case 'done':
      return `event: done\ndata: ${JSON.stringify({ count: event.count })}\n\n`
    case 'error':
    default:
      return `event: error\ndata: ${JSON.stringify({ message: event.message })}\n\n`
  }
}

function broadcast(job: Job, event: ScanEvent): void {
  job.events.push(event)
  const payload = eventToSse(event)
  for (const subscriber of job.subscribers) {
    try {
      subscriber.write(payload)
    } catch {
      job.subscribers.delete(subscriber)
    }
  }
}

/** 启动桥接服务 */
export function startBridge(options: { port?: number; host?: string } = {}): Promise<BridgeHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_BRIDGE_PORT

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      // port 传 0 时由系统分配：返回实际端口，方便测试与提示
      const address = server.address()
      const boundPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            for (const job of jobs.values()) {
              for (const subscriber of job.subscribers) subscriber.end()
              job.subscribers.clear()
            }
            server.close(() => done())
          }),
      })
    })
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  if (url.pathname === '/status') {
    const active = [...jobs.values()].filter((j) => !j.finished)
    const last = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
    sendJson(res, 200, {
      ok: true,
      version: BRIDGE_VERSION,
      busy: active.length > 0,
      lastJobId: last?.id ?? null,
      lastCount: last?.result.length ?? 0,
    })
    return
  }

  if (url.pathname === '/start-scan' && req.method === 'POST') {
    const body = parseStartScanRequest(await readBody(req))
    if (!body) {
      sendJson(res, 400, { ok: false, error: '请求体解析失败（需要 JSON 对象）' })
      return
    }
    if (typeof body.host !== 'string' || body.host.trim() === '') {
      sendJson(res, 400, { ok: false, error: '缺少 host 参数' })
      return
    }

    const job: Job = {
      id: `job-${Date.now()}-${++jobCounter}`,
      startedAt: Date.now(),
      events: [],
      subscribers: new Set(),
      result: [],
      finished: false,
    }
    jobs.set(job.id, job)

    void (async () => {
      try {
        // 面板只发 host/token/callback/top，候选在这里自动生成；manual 优先级最高
        const plan = await resolveScanCandidates(body)
        if (plan.candidates.length === 0) {
          broadcast(job, {
            type: 'error',
            message: '没有可用的候选 IP：请检查 candidates / manual / cidr 参数',
          })
          job.finished = true
          return
        }
        // stage 0：把候选来源告知面板（一键优选时会显示「已自动生成 N 个候选 IP」）
        broadcast(job, {
          type: 'progress',
          stage: 0,
          done: 0,
          total: plan.candidates.length,
          message: describePlan(plan),
        })
        const summary = await runScan({
          host: body.host.trim(),
          port: body.port ?? 443,
          candidates: plan.candidates,
          // 国家过滤（可多选）：不传 = 全量；无效代码在 normalizeCountryFilter 里被丢弃
          countries: Array.isArray(body.countries) ? body.countries : undefined,
          top: body.top ?? 15,
          onProgress: (event) => broadcast(job, event),
        })
        job.result = summary.entries
        if (body.callback && body.token) {
          const result = await postResults(body.callback, body.token, formatEntries(summary.entries))
          broadcast(
            job,
            result.ok
              ? { type: 'done', count: summary.entries.length }
              : { type: 'error', message: `回传失败：${result.error ?? '未知错误'}` }
          )
        } else {
          broadcast(job, { type: 'done', count: summary.entries.length })
        }
      } catch (err) {
        broadcast(job, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        job.finished = true
        for (const subscriber of job.subscribers) {
          try {
            subscriber.end()
          } catch {
            /* 已结束 */
          }
        }
        job.subscribers.clear()
      }
    })()

    sendJson(res, 200, { ok: true, jobId: job.id })
    return
  }

  if (url.pathname === '/events') {
    const jobId = url.searchParams.get('jobId') ?? ''
    const job = jobs.get(jobId) ?? [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!job) {
      sendJson(res, 404, { ok: false, error: '没有正在运行的任务' })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    })

    // 回放历史事件
    for (const event of job.events) res.write(eventToSse(event))
    if (job.finished) {
      res.end()
      return
    }

    job.subscribers.add(res)
    req.on('close', () => {
      job.subscribers.delete(res)
    })
    return
  }

  if (url.pathname === '/results') {
    const job = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
    sendJson(res, 200, {
      ok: true,
      entries: job?.result ?? [],
      lines: formatEntries(job?.result ?? []),
    })
    return
  }

  sendJson(res, 404, { ok: false, error: '接口不存在' })
}
