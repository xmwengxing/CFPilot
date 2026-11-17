/**
 * Phase 1 —— CF API 扩展（D1 / DO）单测。
 *
 * 防什么：
 *   1. 建库 / query / 建 DO 命名空间的**端点路径与 HTTP 方法**写错（真机会 404/405）。
 *   2. Worker 上传的 metadata 里 d1 / durable_object_namespace 绑定字段形状错
 *      （配置层是 database_id，API 层是 id —— 极易照搬错）。
 *   3. migrations 没被写进 metadata → DO 的 SQLite 类不会创建 → 盲中继房间失效。
 *   4. schema 常量与权威 migrations 文件漂移（edge-relay 是权威源）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CloudflareClient } from '../src/deploy/cf-api'
import {
  SCHEMA_DEVICES_SQL,
  SCHEMA_AUTH_SQL,
  EDGE_RELAY_SCHEMAS,
  splitSchemaSql,
} from '../src/deploy/edge-relay-schema'

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result: body }), { status, headers: { 'Content-Type': 'application/json' } })
}

interface CapturedRequest { url: string; method: string; body: string | undefined }

function mockApi(handler: (req: CapturedRequest) => Response): CapturedRequest[] {
  const seen: CapturedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    seen.push(req)
    return handler(req)
  }))
  return seen
}

const API = 'https://api.test/v4'
const ACCT = 'acct123'
const client = () => new CloudflareClient({ token: 'tok', apiBase: API })

describe('D1 API', () => {
  it('createD1Database 走 POST /d1/database，body 只有 name，返回 uuid', async () => {
    const seen = mockApi(() => jsonResponse({ uuid: 'db-uuid-1', name: 'mobihop-monitor' }))
    const db = await client().createD1Database(ACCT, 'mobihop-monitor')
    expect(db.uuid).toBe('db-uuid-1')
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe(`${API}/accounts/${ACCT}/d1/database`)
    expect(JSON.parse(seen[0]!.body!)).toEqual({ name: 'mobihop-monitor' })
  })

  it('queryD1 走 POST /d1/database/{id}/query，body 是 {sql}', async () => {
    const seen = mockApi(() => jsonResponse([{ results: [], success: true }]))
    const out = await client().queryD1(ACCT, 'db-uuid-1', 'CREATE TABLE t (id INTEGER)')
    expect(out).toHaveLength(1)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe(`${API}/accounts/${ACCT}/d1/database/db-uuid-1/query`)
    expect(JSON.parse(seen[0]!.body!)).toEqual({ sql: 'CREATE TABLE t (id INTEGER)' })
  })

  it('listD1Databases 带可选 name 查询参数', async () => {
    const seen = mockApi(() => jsonResponse([]))
    await client().listD1Databases(ACCT, 'mobihop-monitor')
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.url).toContain('name=mobihop-monitor')
  })
})

describe('Durable Objects API', () => {
  /**
   * 真机（2026-11-17）实测：手动建 DO 命名空间已不受支持：
   *   {name,class} → 10100 class cannot be set without script
   *   {name,script,class} → 10099 需用 new_sqlite_classes migration 创建
   * 因此 createDoNamespace 主动抛错，防止误用；DO 命名空间由 uploadScript 的
   * migrations 自动创建（见下方 metadata 测试）。
   */
  it('createDoNamespace 已废弃：调用即抛错，不发请求', async () => {
    const seen = mockApi(() => jsonResponse({}))
    await expect(client().createDoNamespace()).rejects.toThrow('new_sqlite_classes')
    expect(seen).toHaveLength(0)
  })

  it('listDoNamespaces 走 GET（仅用于预检/观测，不用于创建）', async () => {
    const seen = mockApi(() => jsonResponse([]))
    await client().listDoNamespaces(ACCT)
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.url).toContain('/workers/durable_objects/namespaces')
  })
})

describe('uploadScript metadata 绑定与 DO 声明', () => {
  it('旧路径：migrations 数组仍可写入 metadata（兼容性）', async () => {
    const seen = mockApi(() => jsonResponse(null))
    await client().uploadScript(ACCT, 'edge-relay', {
      mainModule: 'index.js',
      code: 'export default { fetch() {} }',
      compatibilityDate: '2026-01-01',
      bindings: [
        { name: 'DB', type: 'd1', id: 'db-uuid-1' },
        { name: 'MESH_ROOM', type: 'durable_object_namespace', class_name: 'MeshRoom' },
        { name: 'KV', type: 'kv_namespace', namespace_id: 'kv-1' },
      ],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['MeshRoom'] }],
    })

    // 上传是 multipart，取 metadata 文件段
    const form = (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as FormData
    const meta = JSON.parse((form.get('metadata') as Blob).text ? await (form.get('metadata') as Blob).text() : '') as {
      main_module: string
      compatibility_date: string
      bindings: Array<Record<string, unknown>>
      migrations: Array<Record<string, unknown>>
    }
    expect(meta.main_module).toBe('index.js')
    const d1 = meta.bindings.find((b) => b.name === 'DB')!
    expect(d1.type).toBe('d1')
    expect(d1.id).toBe('db-uuid-1')
    expect(d1).not.toHaveProperty('database_id')
    const doBind = meta.bindings.find((b) => b.name === 'MESH_ROOM')!
    expect(doBind.type).toBe('durable_object_namespace')
    expect(doBind.class_name).toBe('MeshRoom')
    expect(meta.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['MeshRoom'] }])
    expect(seen).toHaveLength(1)
  })

  /**
   * 真机 2026-11-17：新版平台用 exports 声明 DO，migrations 数组会报
   * "cannot unmarshal array into Metadata.migrations of type reader.ActorMigrations"。
   * edge deploy 走这条路径。
   */
  it('新路径：doExports 写入 metadata.exports（声明式 DO，真机验证）', async () => {
    mockApi(() => jsonResponse(null))
    await client().uploadScript(ACCT, 'edge-relay', {
      mainModule: 'index.js',
      code: 'export class MeshRoom {}',
      compatibilityDate: '2026-01-01',
      bindings: [],
      doExports: {
        MeshRoom: { type: 'durable-object', state: 'created', storage: 'sqlite' },
      },
    })
    const form = (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as FormData
    const meta = JSON.parse(await (form.get('metadata') as Blob).text()) as {
      exports: Record<string, { type: string; state: string; storage: string }>
      migrations?: unknown
    }
    expect(meta.exports).toEqual({
      MeshRoom: { type: 'durable-object', state: 'created', storage: 'sqlite' },
    })
    expect(meta.migrations).toBeUndefined()
  })
})

describe('内置 schema 常量', () => {
  const repoRoot = resolve(process.cwd())
  const migrationsDir = resolve(repoRoot, 'packages/edge-relay/cf-worker-relay/migrations')

  it('与权威 migrations 文件语义一致（含关键建表语句）', () => {
    const init = readFileSync(resolve(migrationsDir, '0001_init.sql'), 'utf8')
    const auth = readFileSync(resolve(migrationsDir, '0002_auth.sql'), 'utf8')
    for (const table of ['CREATE TABLE IF NOT EXISTS devices', 'idx_devices_last_seen']) {
      expect(SCHEMA_DEVICES_SQL).toContain(table)
      expect(init).toContain(table)
    }
    for (const table of ['CREATE TABLE IF NOT EXISTS auth', 'CREATE TABLE IF NOT EXISTS sessions', 'idx_sessions_expires']) {
      expect(SCHEMA_AUTH_SQL).toContain(table)
      expect(auth).toContain(table)
    }
  })

  it('splitSchemaSql 保留建表语句、剥离注释与空段', () => {
    const stmts = splitSchemaSql(EDGE_RELAY_SCHEMAS[0]!)
    expect(stmts).toHaveLength(2)
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS devices')
    expect(stmts[0]).not.toContain('--')
    expect(stmts[1]).toContain('CREATE INDEX IF NOT EXISTS idx_devices_last_seen')
  })

  it('两份 schema 共拆出 5 条可执行 SQL', () => {
    const all = EDGE_RELAY_SCHEMAS.flatMap(splitSchemaSql)
    expect(all).toHaveLength(5)
    for (const s of all) expect(s).toMatch(/^(CREATE TABLE|CREATE INDEX)/)
  })
})
