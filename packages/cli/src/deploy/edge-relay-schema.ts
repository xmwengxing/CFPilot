/**
 * 盲中继 / 云监测台 D1 schema（内置常量）。
 *
 * 来源：packages/edge-relay/cf-worker-relay/migrations/{0001_init.sql,0002_auth.sql}，
 * 即权威 edge 工程的迁移文件。这里以 TS 常量内置，是为了让部署时**动态建库后
 * 立即初始化**，不依赖 wrangler、不依赖本地 migration 文件、不使用任何硬编码
 * database_id（原 wrangler.toml 里的 f18c66ff-... 是别人账户的库）。
 *
 * 维护约定：改 schema 时必须两处同步 ——
 *   1. packages/edge-relay/.../migrations/*.sql（权威）
 *   2. 本文件的常量字符串
 * 且两处 SQL 语义必须一致（CREATE IF NOT EXISTS 保证重复部署幂等）。
 *
 * 这些 SQL 受 FILELIST.json 之外的保护：edge-relay 的哈希清单覆盖 migrations
 * 文件，本常量由单测断言与 migrations 文件一致（见 edge-relay-schema.test.ts）。
 */

/** devices 表：监测台设备心跳（与 Worker 的 handleHeartbeat / handleDevices 对齐） */
export const SCHEMA_DEVICES_SQL = `-- 云监测台 D1 schema（来自 edge-relay/migrations/0001_init.sql）
CREATE TABLE IF NOT EXISTS devices (
  node_id TEXT PRIMARY KEY,
  alias TEXT,
  virtual_ipv4 TEXT,
  version TEXT,
  last_ip TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_ms DESC);`

/** auth / sessions 表：监测台登录鉴权（与 Worker 的 PBKDF2 + Bearer session 对齐） */
export const SCHEMA_AUTH_SQL = `-- 云监测台鉴权 D1 schema（来自 edge-relay/migrations/0002_auth.sql）
CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY,
  password_hash TEXT,
  salt TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at_ms);`

/** 按顺序执行的完整 schema（先建业务表，再建鉴权表） */
export const EDGE_RELAY_SCHEMAS: readonly string[] = [SCHEMA_DEVICES_SQL, SCHEMA_AUTH_SQL]

/**
 * 把 schema 拆成逐条 SQL 语句。
 *
 * Cloudflare D1 的 /query 端点一次只执行一条语句（body {sql}），
 * 所以含多条 CREATE 的文件要拆开逐条发送。
 * 简单按分号拆分即可：这些 SQL 里没有字符串字面量包含分号的情况。
 */
export function splitSchemaSql(sql: string): string[] {
  // 先逐行剥掉 `--` 注释，再按分号拆——否则注释会与紧随其后的第一条
  // CREATE 落在同一段里，导致 startsWith('--') 把整段（含建表语句）误删。
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
