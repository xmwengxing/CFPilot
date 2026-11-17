-- MobiHop 云监测台 D1 schema（与 cf-monitor 历史一致，合并后随统一 Worker 使用）
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
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_ms DESC);
