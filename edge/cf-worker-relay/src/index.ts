// P4.2：MobiHop Cloudflare Workers + Durable Objects 边缘盲中继。
//
// 拓扑：
//   node A ──wss──▶ Worker (/mesh/<network_hash>?peer_id=...) ──▶ 同名 DO 实例（房间）
//   node B ──wss──▶                        同一 DO（房间）──▶ 转发 32B 头 + 密文载荷
//
// 隔离：`idFromName(network_hash)` 保证**一个房间 = 一个 DO 单例**；
//       不同 network_hash 的 DO 之间没有任何共享状态。
// 零知识：本 Worker/DO 只读 32B 头；载荷只做长度校验并透传，绝不解密；
//       日志只允许 room 前 4 字符 + peer_id + 包长，绝不打印载荷。
//
// 说明：DO 内只用内存状态（限速窗口 / 计数 / WebSocket 标签）。Hibernation 唤醒后
// 这些计数会重置——这是刻意的「不持久化任何载荷」取舍；会话元数据也不需要落盘。

import dashboardHtml from "../dashboard.html";
import {
  MAX_WIRE_FRAME,
  SlidingWindow,
  decideForward,
  networkHashFromPath,
  parseFrame,
  prepareForwardFrame,
  roomLogPrefix,
  validateNetworkHash,
  validatePeerId,
  type RateLimits,
} from "./proto.ts";

export interface Env {
  /** wrangler.toml 中的 Durable Object 绑定：一个房间一个实例。 */
  MESH_ROOM: DurableObjectNamespace;
  /** D1 监测数据库绑定（与 cf-monitor 共用 schema）。 */
  DB: D1Database;
  /** 监测上报令牌（secret）；未设置时监测端点返回 503。 */
  MONITOR_TOKEN?: string;
  /** 每连接滑动窗口（字符串形式的整数；缺省见 DEFAULT_LIMITS）。 */
  WINDOW_MS?: string;
  MAX_BYTES_PER_WINDOW?: string;
  MAX_PACKETS_PER_WINDOW?: string;
  /** 单房间 WebSocket 连接上限。 */
  MAX_PEERS_PER_ROOM?: string;
}

const DEFAULT_LIMITS: RateLimits = {
  windowMs: 1000,
  maxBytes: 1024 * 1024,
  maxPackets: 2000,
};
const DEFAULT_MAX_PEERS = 512;
const MAX_PEERS_HARD_CAP = 4096;

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function limitsFromEnv(env: Env): RateLimits {
  return {
    windowMs: envInt(env.WINDOW_MS, DEFAULT_LIMITS.windowMs, 1, 60_000),
    maxBytes: envInt(env.MAX_BYTES_PER_WINDOW, DEFAULT_LIMITS.maxBytes, 32, 1 << 30),
    maxPackets: envInt(env.MAX_PACKETS_PER_WINDOW, DEFAULT_LIMITS.maxPackets, 1, 1_000_000),
  };
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** 从请求里取出并校验房间 / peer_id；失败返回 null（调用方回 400/426）。 */
function validatedTarget(request: Request): { hash: string; peerId: string } | null {
  const url = new URL(request.url);
  const hash = networkHashFromPath(url.pathname);
  const peerId = url.searchParams.get("peer_id");
  if (!hash || typeof peerId !== "string" || !validatePeerId(peerId)) {
    return null;
  }
  return { hash, peerId };
}

/**
 * Worker 入口：只做「校验 + 按 network_hash 路由到同名 DO」。
 *
 * 不在此处读写帧；所有转发 / 限速 / 计数都在 DO 内完成。
 */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Monitor-Token",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get("X-Monitor-Token") || "";
  if (!env.MONITOR_TOKEN || token !== env.MONITOR_TOKEN) {
    return json({ code: "unauthorized", message: "invalid monitor token" }, 401);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ code: "bad_request", message: "invalid json" }, 400);
  }
  const nodeId = String(body?.node_id ?? "").trim();
  if (!/^[0-9a-f]{16}$/i.test(nodeId)) {
    return json({ code: "bad_request", message: "node_id must be 16 hex" }, 400);
  }
  const now = Date.now();
  const alias = String(body?.alias ?? "").slice(0, 64);
  const vip = body?.virtual_ipv4 ? String(body.virtual_ipv4).slice(0, 48) : null;
  const version = body?.version ? String(body.version).slice(0, 32) : null;
  const online = body?.online ? 1 : 0;
  const ip = request.headers.get("CF-Connecting-IP") || null;
  await env.DB.prepare(
    `INSERT INTO devices (node_id, alias, virtual_ipv4, version, last_ip, online, last_seen_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       alias=excluded.alias, virtual_ipv4=excluded.virtual_ipv4, version=excluded.version,
       last_ip=excluded.last_ip, online=excluded.online,
       last_seen_ms=excluded.last_seen_ms, updated_at_ms=excluded.updated_at_ms`,
  )
    .bind(nodeId, alias || null, vip, version, ip, online, now, now)
    .run();
  return json({ ok: true, node_id: nodeId, ts: now });
}

async function handleDevices(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT node_id, alias, virtual_ipv4, version, last_ip, online, last_seen_ms
     FROM devices ORDER BY last_seen_ms DESC`,
  ).all();
  const now = Date.now();
  const STALE_MS = 90_000;
  const devices = (results || []).map((r: any) => ({
    nodeId: r.node_id,
    alias: r.alias,
    virtualIpv4: r.virtual_ipv4,
    version: r.version,
    lastIp: r.last_ip,
    online: r.online === 1 && now - (r.last_seen_ms || 0) < STALE_MS,
    lastSeenMs: r.last_seen_ms,
  }));
  return json({ devices, generatedAtMs: now });
}

// ---------- 监测台鉴权 ----------

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveHash(password: string, salt: Uint8Array): Promise<string> {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100000, hash: "SHA-256" },
    km,
    256,
  );
  return b64(new Uint8Array(bits));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hasPassword(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT password_hash FROM auth WHERE id=1").first<{ password_hash: string | null }>();
  return !!row?.password_hash;
}

async function getSession(request: Request, env: Env): Promise<{ token: string; expiresAtMs: number } | null> {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : request.headers.get("X-Monitor-Session") || "";
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT token, expires_at_ms FROM sessions WHERE token=?1",
  )
    .bind(token)
    .first<{ token: string; expires_at_ms: number }>();
  if (!row) return null;
  if (Date.now() > row.expires_at_ms) {
    await env.DB.prepare("DELETE FROM sessions WHERE token=?1").bind(token).run();
    return null;
  }
  return { token: row.token, expiresAtMs: row.expires_at_ms };
}

async function handleAuthStatus(env: Env): Promise<Response> {
  return json({ setupRequired: !(await hasPassword(env)) });
}

async function handleAuthSetup(request: Request, env: Env): Promise<Response> {
  if (await hasPassword(env)) {
    return json({ code: "conflict", message: "password already set; use change-password" }, 409);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ code: "bad_request", message: "invalid json" }, 400);
  }
  const password = String(body?.password ?? "");
  if (password.length < 8) {
    return json({ code: "bad_request", message: "password must be at least 8 chars" }, 400);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO auth (id, password_hash, salt, updated_at_ms) VALUES (1, ?1, ?2, ?3) ON CONFLICT(id) DO NOTHING",
  )
    .bind(hash, b64(salt), now)
    .run();
  // ensure only if empty
  const check = await env.DB.prepare("SELECT password_hash FROM auth WHERE id=1").first<{ password_hash: string | null }>();
  if (!check?.password_hash) {
    // race: someone else set it
    return json({ code: "conflict", message: "password already set" }, 409);
  }
  return json({ ok: true });
}

async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  if (!(await hasPassword(env))) {
    return json({ code: "setup_required", message: "password not set" }, 412);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ code: "bad_request", message: "invalid json" }, 400);
  }
  const password = String(body?.password ?? "");
  const row = await env.DB.prepare("SELECT password_hash, salt FROM auth WHERE id=1").first<{
    password_hash: string;
    salt: string;
  }>();
  if (!row) return json({ code: "internal", message: "auth row missing" }, 500);
  const salt = unb64(row.salt);
  const hash = await deriveHash(password, salt);
  if (!timingSafeEqual(hash, row.password_hash)) {
    return json({ code: "unauthorized", message: "invalid password" }, 401);
  }
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expires = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare("INSERT INTO sessions (token, created_at_ms, expires_at_ms) VALUES (?1, ?2, ?3)").bind(
    token,
    Date.now(),
    expires,
  ).run();
  return json({ token, expiresAtMs: expires });
}

async function handleAuthChangePassword(request: Request, env: Env): Promise<Response> {
  const sess = await getSession(request, env);
  if (!sess) return json({ code: "unauthorized", message: "session required" }, 401);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ code: "bad_request", message: "invalid json" }, 400);
  }
  const oldPassword = String(body?.oldPassword ?? "");
  const newPassword = String(body?.newPassword ?? "");
  if (newPassword.length < 8) {
    return json({ code: "bad_request", message: "new password must be at least 8 chars" }, 400);
  }
  const row = await env.DB.prepare("SELECT password_hash, salt FROM auth WHERE id=1").first<{
    password_hash: string;
    salt: string;
  }>();
  if (!row) return json({ code: "internal", message: "auth row missing" }, 500);
  const oldHash = await deriveHash(oldPassword, unb64(row.salt));
  if (!timingSafeEqual(oldHash, row.password_hash)) {
    return json({ code: "unauthorized", message: "invalid old password" }, 401);
  }
  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newHash = await deriveHash(newPassword, newSalt);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE auth SET password_hash=?1, salt=?2, updated_at_ms=?3 WHERE id=1",
  )
    .bind(newHash, b64(newSalt), now)
    .run();
  // invalidate all other sessions (keep current)
  await env.DB.prepare("DELETE FROM sessions WHERE token<>?1").bind(sess.token).run();
  return json({ ok: true });
}

async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  const sess = await getSession(request, env);
  if (sess) {
    await env.DB.prepare("DELETE FROM sessions WHERE token=?1").bind(sess.token).run();
  }
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 监测路由（HTTP，不走 WebSocket/DO 中继）。
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (path === "/health" && request.method === "GET") {
      return json({ ok: true });
    }
    if (path === "/" && request.method === "GET" && !isWebSocketUpgrade(request)) {
      return new Response(dashboardHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    // 鉴权路由
    if (path === "/auth/status" && request.method === "GET") {
      try { return await handleAuthStatus(env); } catch (e: any) { return json({ code: "internal", message: String(e?.message ?? e) }, 500); }
    }
    if (path === "/auth/setup" && request.method === "POST") {
      try { return await handleAuthSetup(request, env); } catch (e: any) { return json({ code: "internal", message: String(e?.message ?? e) }, 500); }
    }
    if (path === "/auth/login" && request.method === "POST") {
      try { return await handleAuthLogin(request, env); } catch (e: any) { return json({ code: "internal", message: String(e?.message ?? e) }, 500); }
    }
    if (path === "/auth/change-password" && request.method === "POST") {
      try { return await handleAuthChangePassword(request, env); } catch (e: any) { return json({ code: "internal", message: String(e?.message ?? e) }, 500); }
    }
    if (path === "/auth/logout" && request.method === "POST") {
      try { return await handleAuthLogout(request, env); } catch (e: any) { return json({ code: "internal", message: String(e?.message ?? e) }, 500); }
    }
    if (path === "/heartbeat" && request.method === "POST") {
      try {
        return await handleHeartbeat(request, env);
      } catch (e: any) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/devices" && request.method === "GET") {
      try {
        const sess = await getSession(request, env);
        if (!sess) return json({ code: "unauthorized", message: "session required" }, 401);
        return await handleDevices(env);
      } catch (e: any) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }

    // 其余：盲中继 WebSocket 路径。
    if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
      return new Response("MobiHop edge relay: WebSocket upgrade required", { status: 426 });
    }
    const target = validatedTarget(request);
    if (!target || !validateNetworkHash(target.hash)) {
      return new Response("MobiHop edge relay: invalid /mesh/<network_hash> or peer_id", {
        status: 400,
      });
    }
    const stub = env.MESH_ROOM.get(env.MESH_ROOM.idFromName(target.hash));
    // 直接把原请求（含 WebSocket Upgrade 头 / 路径 / query）转给 DO。
    return stub.fetch(request);
  },
};

/** 单房间 Durable Object：WebSocket Hibernation API + 房间内盲转发。 */
export class MeshRoom {
  private readonly state: DurableObjectState;
  private readonly limits: RateLimits;
  private readonly maxPeers: number;
  /** peer_id → 滑动窗口（Hibernation 后重置）。 */
  private readonly windows = new Map<string, SlidingWindow>();
  private roomHash = "";

  // 计数（仅内存；Hibernation 后重置）。
  private forwarded = 0;
  private dropped = 0;
  private rateLimited = 0;
  private invalid = 0;
  private oversize = 0;
  private kicked = 0;
  private lastLogAt = 0;
  private lastDropLogAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.limits = limitsFromEnv(env);
    this.maxPeers = envInt(env.MAX_PEERS_PER_ROOM, DEFAULT_MAX_PEERS, 1, MAX_PEERS_HARD_CAP);
  }

  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response("upgrade required", { status: 426 });
    }
    const target = validatedTarget(request);
    if (!target) {
      return new Response("invalid room / peer_id", { status: 400 });
    }
    if (this.roomHash === "") {
      this.roomHash = target.hash;
    } else if (this.roomHash !== target.hash) {
      // DO 实例由 idFromName 唯一决定；出现不同 hash 说明请求被错误路由。
      return new Response("room mismatch", { status: 400 });
    }
    const peerId = target.peerId;

    // 同一 peer_id 重复连接：新连踢旧连（避免同一 NodeId 双链路导致帧乱序）。
    const existing = this.state.getWebSockets(peerId);
    for (const old of existing) {
      try {
        old.close(4001, "replaced by newer connection");
      } catch {
        // 已关闭则忽略。
      }
      this.kicked += 1;
    }

    const others = this.state.getWebSockets().length - existing.length;
    if (others >= this.maxPeers) {
      this.log("room_full", peerId, 0);
      return new Response("room full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // WebSocket Hibernation API：标签用于按 peer_id 精确单播（不维护内存映射）。
    this.state.acceptWebSocket(server, [peerId]);
    // 重连后重置该 peer 的限速窗口（旧窗口属于旧连接）。
    this.windows.set(peerId, new SlidingWindow(this.limits));

    this.log("join", peerId, 0);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 一条 WS 二进制消息 = 一个完整 MobiHop 帧（32B 头 + 载荷）。 */
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const sender = this.senderPeerId(ws);
    if (!sender) {
      this.invalid += 1;
      return;
    }
    if (typeof message === "string") {
      // 协议只接受二进制帧（与 Rust WsLink 语义一致）。
      this.invalid += 1;
      this.log("drop_invalid", sender, message.length);
      return;
    }
    const bytes = normalizeBinary(message);
    if (bytes === null) {
      this.invalid += 1;
      return;
    }
    const byteLen = bytes.byteLength;

    const window = this.windows.get(sender) ?? new SlidingWindow(this.limits);
    this.windows.set(sender, window);
    const rate = window.allow(Date.now(), byteLen);
    if (!rate.allowed) {
      this.rateLimited += 1;
      this.log(`rate_limited_${rate.reason}`, sender, byteLen);
      return;
    }

    const parsed = parseFrame(bytes);
    if (!parsed.ok) {
      if (parsed.reason === "oversize") {
        this.oversize += 1;
      } else {
        this.invalid += 1;
      }
      this.log(`drop_${parsed.reason}`, sender, byteLen);
      return;
    }

    const decision = decideForward(parsed.frame, sender, this.peerIds());
    switch (decision.kind) {
      case "drop":
        this.dropped += 1;
        this.log(`drop_${decision.reason}`, sender, byteLen);
        return;
      case "unicast": {
        const out = prepareForwardFrame(parsed.frame);
        if (this.deliver(decision.target, out)) {
          this.forwarded += 1;
          this.maybeLogStats(sender, byteLen);
        } else {
          this.dropped += 1;
          this.log("drop_target_gone", sender, byteLen);
        }
        return;
      }
      case "broadcast": {
        // 只改 32B 头（TTL / Relayed），载荷逐字节原样转发；除发送方外全部成员。
        const out = prepareForwardFrame(parsed.frame);
        for (const target of decision.targets) {
          if (this.deliver(target, out)) {
            this.forwarded += 1;
          }
        }
        this.maybeLogStats(sender, byteLen);
        return;
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    const peer = this.senderPeerId(ws);
    if (peer) {
      this.windows.delete(peer);
      this.log("close", peer, reason.length);
      // 可选：显式 close 以保证 Hibernation 连接被清理。
      try {
        ws.close(code === 4001 ? 4001 : 1000, code === 4001 ? "replaced" : "closed");
      } catch {
        // 已关闭。
      }
    }
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    // 只记录错误类别，不记录任何帧 / 载荷内容。
    this.invalid += 1;
    this.log("error", "unknown", 0);
    void error;
  }

  private senderPeerId(ws: WebSocket): string | null {
    const tags = this.state.getTags(ws);
    const tag = tags[0];
    return tag && validatePeerId(tag) ? tag : null;
  }

  private peerIds(): string[] {
    return this.state.getWebSockets().flatMap((ws) => this.state.getTags(ws));
  }

  private deliver(target: string, frame: Uint8Array): boolean {
    const sockets = this.state.getWebSockets(target);
    let sent = false;
    for (const ws of sockets) {
      try {
        ws.send(frame);
        sent = true;
      } catch {
        // 对端已断开；忽略（计数在调用方）。
      }
    }
    return sent;
  }

  /** 日志只允许 room 前 4 字符 + peer_id + 包长（绝不打印载荷 / 完整 hash）。 */
  private log(event: string, peerId: string, byteLen: number): void {
    // 丢弃 / 限速日志做 1s 节流：被攻击时不能把日志量变成成本放大。
    const now = Date.now();
    if (event.startsWith("drop_") || event.startsWith("rate_limited")) {
      if (now - this.lastDropLogAt < 1000) {
        return;
      }
      this.lastDropLogAt = now;
    }
    console.log(
      `[mh-edge] evt=${event} room=${roomLogPrefix(this.roomHash)} peer=${peerId} bytes=${byteLen}`,
    );
  }

  /** 每 500 个转发包输出一次计数（避免逐包日志造成费用与噪音）。 */
  private maybeLogStats(peerId: string, byteLen: number): void {
    const now = Date.now();
    if (this.forwarded % 500 !== 0 || now - this.lastLogAt < 1000) {
      return;
    }
    this.lastLogAt = now;
    console.log(
      `[mh-edge] stats room=${roomLogPrefix(this.roomHash)} peer=${peerId} bytes=${byteLen} ` +
        `forwarded=${this.forwarded} dropped=${this.dropped} rate_limited=${this.rateLimited} ` +
        `invalid=${this.invalid} oversize=${this.oversize} kicked=${this.kicked}`,
    );
  }
}

function normalizeBinary(message: ArrayBuffer | ArrayBufferView): Uint8Array | null {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (ArrayBuffer.isView(message)) {
    const view = message;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

/** 供编译期确认：帧尺寸常量与 Rust 侧一致（1432 = 32 + 1400）。 */
export const WIRE_FRAME_LIMIT = MAX_WIRE_FRAME;
