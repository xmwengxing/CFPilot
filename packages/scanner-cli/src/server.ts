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

export const BRIDGE_VERSION = '0.1.0'
export const DEFAULT_BRIDGE_PORT = 19527

export interface StartScanRequest {
  host: string
  port?: number
  token?: string
  callback?: string
  top?: number
  candidates?: string[]
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
      resolve({
        server,
        port,
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
    let body: StartScanRequest
    try {
      body = JSON.parse((await readBody(req)) || '{}') as StartScanRequest
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体解析失败' })
      return
    }
    if (!body.host) {
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
        const candidates = body.candidates ?? []
        if (candidates.length === 0) {
          broadcast(job, { type: 'error', message: '没有候选 IP，请先运行一次完整扫描' })
          job.finished = true
          return
        }
        const summary = await runScan({
          host: body.host,
          port: body.port ?? 443,
          candidates,
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
