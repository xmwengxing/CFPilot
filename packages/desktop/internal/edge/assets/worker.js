// ../edge-relay/cf-worker-relay/src/proto.ts
var MAGIC = 77;
var VERSION = 1;
var HEADER_LEN = 32;
var MAX_FRAME = 1400;
var MAX_WIRE_FRAME = HEADER_LEN + MAX_FRAME;
var BROADCAST_HEX = "ffffffffffffffff";
var OFF = {
  magic: 0,
  version: 1,
  msgType: 2,
  flags: 3,
  ttl: 4,
  reserved: 5,
  payloadLen: 6,
  src: 8,
  dst: 16,
  counter: 24
};
var MESSAGE_TYPES = [1, 2, 3, 4, 5, 6, 7];
var FLAG_RELAYED = 2;
function nodeIdHex(bytes, offset) {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    const byte = bytes[offset + i] ?? 0;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
function fail(reason) {
  return { ok: false, reason };
}
function parseFrame(input) {
  if (input.length > MAX_WIRE_FRAME) {
    return fail("oversize");
  }
  if (input.length < HEADER_LEN) {
    return fail("short");
  }
  if (input[OFF.magic] !== MAGIC) {
    return fail("bad_magic");
  }
  if (input[OFF.version] !== VERSION) {
    return fail("bad_version");
  }
  const msgType = input[OFF.msgType] ?? 0;
  if (!MESSAGE_TYPES.includes(msgType)) {
    return fail("unknown_type");
  }
  if ((input[OFF.reserved] ?? 1) !== 0) {
    return fail("reserved_nonzero");
  }
  const ttl = input[OFF.ttl] ?? 0;
  if (ttl > 64) {
    return fail("ttl_out_of_range");
  }
  const payloadLen = (input[OFF.payloadLen] ?? 0) << 8 | (input[OFF.payloadLen + 1] ?? 0);
  if (HEADER_LEN + payloadLen !== input.length) {
    return fail("length_mismatch");
  }
  const src = nodeIdHex(input, OFF.src);
  const dst = nodeIdHex(input, OFF.dst);
  return {
    ok: true,
    frame: {
      frame: input,
      msgType,
      flags: input[OFF.flags] ?? 0,
      ttl,
      payloadLen,
      src,
      dst,
      broadcast: dst === BROADCAST_HEX
    }
  };
}
function decideForward(parsed, senderPeerId, peerIds) {
  if (parsed.ttl <= 1) {
    return { kind: "drop", reason: "ttl_exhausted" };
  }
  if (parsed.broadcast) {
    const targets = peerIds.filter((peer) => peer !== senderPeerId).slice().sort();
    if (targets.length === 0) {
      return { kind: "drop", reason: "no_members" };
    }
    return { kind: "broadcast", targets };
  }
  if (parsed.dst === senderPeerId) {
    return { kind: "drop", reason: "self_unicast" };
  }
  if (!peerIds.includes(parsed.dst)) {
    return { kind: "drop", reason: "unknown_target" };
  }
  return { kind: "unicast", target: parsed.dst };
}
function prepareForwardFrame(parsed) {
  const out = parsed.frame.slice();
  out[OFF.ttl] = parsed.ttl - 1;
  out[OFF.flags] = parsed.flags | FLAG_RELAYED;
  return out;
}
var SlidingWindow = class {
  entries = [];
  limits;
  constructor(limits) {
    if (limits.windowMs <= 0 || limits.maxBytes <= 0 || limits.maxPackets <= 0) {
      throw new Error("invalid rate limits");
    }
    this.limits = limits;
  }
  prune(nowMs) {
    const cutoff = nowMs - this.limits.windowMs;
    while (this.entries.length > 0 && (this.entries[0]?.ts ?? nowMs) <= cutoff) {
      this.entries.shift();
    }
  }
  allow(nowMs, bytes) {
    this.prune(nowMs);
    let usedBytes = 0;
    for (const entry of this.entries) {
      usedBytes += entry.bytes;
    }
    const oldest = this.entries[0]?.ts;
    const retryAfterMs = oldest === void 0 ? this.limits.windowMs : Math.max(0, oldest + this.limits.windowMs - nowMs);
    if (usedBytes + bytes > this.limits.maxBytes) {
      return { allowed: false, reason: "bytes", retryAfterMs };
    }
    if (this.entries.length + 1 > this.limits.maxPackets) {
      return { allowed: false, reason: "packets", retryAfterMs };
    }
    this.entries.push({ ts: nowMs, bytes });
    return { allowed: true };
  }
  /** 窗口内当前用量（观测 / 单测）。 */
  usage(nowMs) {
    this.prune(nowMs);
    let bytes = 0;
    for (const entry of this.entries) {
      bytes += entry.bytes;
    }
    return { bytes, packets: this.entries.length };
  }
};
function validatePeerId(raw) {
  return typeof raw === "string" && /^[0-9a-f]{16}$/.test(raw);
}
function validateNetworkHash(raw) {
  return typeof raw === "string" && /^[0-9a-f]{8,64}$/.test(raw);
}
function networkHashFromPath(pathname) {
  const match = /^\/mesh\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  const hash = match[1] ?? null;
  return validateNetworkHash(hash) ? hash : null;
}
function roomLogPrefix(networkHash) {
  return networkHash.slice(0, 4);
}

// ../edge-relay/cf-worker-relay/src/index.ts
var DEFAULT_LIMITS = {
  windowMs: 1e3,
  maxBytes: 1024 * 1024,
  maxPackets: 2e3
};
var DEFAULT_MAX_PEERS = 512;
var MAX_PEERS_HARD_CAP = 4096;
function envInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}
function limitsFromEnv(env) {
  return {
    windowMs: envInt(env.WINDOW_MS, DEFAULT_LIMITS.windowMs, 1, 6e4),
    maxBytes: envInt(env.MAX_BYTES_PER_WINDOW, DEFAULT_LIMITS.maxBytes, 32, 1 << 30),
    maxPackets: envInt(env.MAX_PACKETS_PER_WINDOW, DEFAULT_LIMITS.maxPackets, 1, 1e6)
  };
}
function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}
function validatedTarget(request) {
  const url = new URL(request.url);
  const hash = networkHashFromPath(url.pathname);
  const peerId = url.searchParams.get("peer_id");
  if (!hash || typeof peerId !== "string" || !validatePeerId(peerId)) {
    return null;
  }
  return { hash, peerId };
}
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Monitor-Token"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}
async function handleHeartbeat(request, env) {
  const token = request.headers.get("X-Monitor-Token") || "";
  if (!env.MONITOR_TOKEN || token !== env.MONITOR_TOKEN) {
    return json({ code: "unauthorized", message: "invalid monitor token" }, 401);
  }
  let body;
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
       last_seen_ms=excluded.last_seen_ms, updated_at_ms=excluded.updated_at_ms`
  ).bind(nodeId, alias || null, vip, version, ip, online, now, now).run();
  return json({ ok: true, node_id: nodeId, ts: now });
}
async function handleDevices(env) {
  const { results } = await env.DB.prepare(
    `SELECT node_id, alias, virtual_ipv4, version, last_ip, online, last_seen_ms
     FROM devices ORDER BY last_seen_ms DESC`
  ).all();
  const now = Date.now();
  const STALE_MS = 9e4;
  const devices = (results || []).map((r) => ({
    nodeId: r.node_id,
    alias: r.alias,
    virtualIpv4: r.virtual_ipv4,
    version: r.version,
    lastIp: r.last_ip,
    online: r.online === 1 && now - (r.last_seen_ms || 0) < STALE_MS,
    lastSeenMs: r.last_seen_ms
  }));
  return json({ devices, generatedAtMs: now });
}
var SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveHash(password, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    km,
    256
  );
  return b64(new Uint8Array(bits));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hasPassword(env) {
  const row = await env.DB.prepare("SELECT password_hash FROM auth WHERE id=1").first();
  return !!row?.password_hash;
}
async function getSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : request.headers.get("X-Monitor-Session") || "";
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT token, expires_at_ms FROM sessions WHERE token=?1"
  ).bind(token).first();
  if (!row) return null;
  if (Date.now() > row.expires_at_ms) {
    await env.DB.prepare("DELETE FROM sessions WHERE token=?1").bind(token).run();
    return null;
  }
  return { token: row.token, expiresAtMs: row.expires_at_ms };
}
async function handleAuthStatus(env) {
  return json({ setupRequired: !await hasPassword(env) });
}
async function handleAuthSetup(request, env) {
  if (await hasPassword(env)) {
    return json({ code: "conflict", message: "password already set; use change-password" }, 409);
  }
  let body;
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
    "INSERT INTO auth (id, password_hash, salt, updated_at_ms) VALUES (1, ?1, ?2, ?3) ON CONFLICT(id) DO NOTHING"
  ).bind(hash, b64(salt), now).run();
  const check = await env.DB.prepare("SELECT password_hash FROM auth WHERE id=1").first();
  if (!check?.password_hash) {
    return json({ code: "conflict", message: "password already set" }, 409);
  }
  return json({ ok: true });
}
async function handleAuthLogin(request, env) {
  if (!await hasPassword(env)) {
    return json({ code: "setup_required", message: "password not set" }, 412);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: "bad_request", message: "invalid json" }, 400);
  }
  const password = String(body?.password ?? "");
  const row = await env.DB.prepare("SELECT password_hash, salt FROM auth WHERE id=1").first();
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
    expires
  ).run();
  return json({ token, expiresAtMs: expires });
}
async function handleAuthChangePassword(request, env) {
  const sess = await getSession(request, env);
  if (!sess) return json({ code: "unauthorized", message: "session required" }, 401);
  let body;
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
  const row = await env.DB.prepare("SELECT password_hash, salt FROM auth WHERE id=1").first();
  if (!row) return json({ code: "internal", message: "auth row missing" }, 500);
  const oldHash = await deriveHash(oldPassword, unb64(row.salt));
  if (!timingSafeEqual(oldHash, row.password_hash)) {
    return json({ code: "unauthorized", message: "invalid old password" }, 401);
  }
  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newHash = await deriveHash(newPassword, newSalt);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE auth SET password_hash=?1, salt=?2, updated_at_ms=?3 WHERE id=1"
  ).bind(newHash, b64(newSalt), now).run();
  await env.DB.prepare("DELETE FROM sessions WHERE token<>?1").bind(sess.token).run();
  return json({ ok: true });
}
async function handleAuthLogout(request, env) {
  const sess = await getSession(request, env);
  if (sess) {
    await env.DB.prepare("DELETE FROM sessions WHERE token=?1").bind(sess.token).run();
  }
  return json({ ok: true });
}
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (path === "/health" && request.method === "GET") {
      return json({ ok: true });
    }
    if (path === "/auth/status" && request.method === "GET") {
      try {
        return await handleAuthStatus(env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/auth/setup" && request.method === "POST") {
      try {
        return await handleAuthSetup(request, env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/auth/login" && request.method === "POST") {
      try {
        return await handleAuthLogin(request, env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/auth/change-password" && request.method === "POST") {
      try {
        return await handleAuthChangePassword(request, env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/auth/logout" && request.method === "POST") {
      try {
        return await handleAuthLogout(request, env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/heartbeat" && request.method === "POST") {
      try {
        return await handleHeartbeat(request, env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (path === "/devices" && request.method === "GET") {
      try {
        const sess = await getSession(request, env);
        if (!sess) return json({ code: "unauthorized", message: "session required" }, 401);
        return await handleDevices(env);
      } catch (e) {
        return json({ code: "internal", message: String(e?.message ?? e) }, 500);
      }
    }
    if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
      return new Response("MobiHop edge relay: WebSocket upgrade required", { status: 426 });
    }
    const target = validatedTarget(request);
    if (!target || !validateNetworkHash(target.hash)) {
      return new Response("MobiHop edge relay: invalid /mesh/<network_hash> or peer_id", {
        status: 400
      });
    }
    const stub = env.MESH_ROOM.get(env.MESH_ROOM.idFromName(target.hash));
    return stub.fetch(request);
  }
};
var MeshRoom = class {
  state;
  limits;
  maxPeers;
  /** peer_id → 滑动窗口（Hibernation 后重置）。 */
  windows = /* @__PURE__ */ new Map();
  roomHash = "";
  // 计数（仅内存；Hibernation 后重置）。
  forwarded = 0;
  dropped = 0;
  rateLimited = 0;
  invalid = 0;
  oversize = 0;
  kicked = 0;
  lastLogAt = 0;
  lastDropLogAt = 0;
  constructor(state, env) {
    this.state = state;
    this.limits = limitsFromEnv(env);
    this.maxPeers = envInt(env.MAX_PEERS_PER_ROOM, DEFAULT_MAX_PEERS, 1, MAX_PEERS_HARD_CAP);
  }
  async fetch(request) {
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
      return new Response("room mismatch", { status: 400 });
    }
    const peerId = target.peerId;
    const existing = this.state.getWebSockets(peerId);
    for (const old of existing) {
      try {
        old.close(4001, "replaced by newer connection");
      } catch {
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
    this.state.acceptWebSocket(server, [peerId]);
    this.windows.set(peerId, new SlidingWindow(this.limits));
    this.log("join", peerId, 0);
    return new Response(null, { status: 101, webSocket: client });
  }
  /** 一条 WS 二进制消息 = 一个完整 MobiHop 帧（32B 头 + 载荷）。 */
  webSocketMessage(ws, message) {
    const sender = this.senderPeerId(ws);
    if (!sender) {
      this.invalid += 1;
      return;
    }
    if (typeof message === "string") {
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
  webSocketClose(ws, code, reason, _wasClean) {
    const peer = this.senderPeerId(ws);
    if (peer) {
      this.windows.delete(peer);
      this.log("close", peer, reason.length);
      try {
        ws.close(code === 4001 ? 4001 : 1e3, code === 4001 ? "replaced" : "closed");
      } catch {
      }
    }
  }
  webSocketError(_ws, error) {
    this.invalid += 1;
    this.log("error", "unknown", 0);
    void error;
  }
  senderPeerId(ws) {
    const tags = this.state.getTags(ws);
    const tag = tags[0];
    return tag && validatePeerId(tag) ? tag : null;
  }
  peerIds() {
    return this.state.getWebSockets().flatMap((ws) => this.state.getTags(ws));
  }
  deliver(target, frame) {
    const sockets = this.state.getWebSockets(target);
    let sent = false;
    for (const ws of sockets) {
      try {
        ws.send(frame);
        sent = true;
      } catch {
      }
    }
    return sent;
  }
  /** 日志只允许 room 前 4 字符 + peer_id + 包长（绝不打印载荷 / 完整 hash）。 */
  log(event, peerId, byteLen) {
    const now = Date.now();
    if (event.startsWith("drop_") || event.startsWith("rate_limited")) {
      if (now - this.lastDropLogAt < 1e3) {
        return;
      }
      this.lastDropLogAt = now;
    }
    console.log(
      `[mh-edge] evt=${event} room=${roomLogPrefix(this.roomHash)} peer=${peerId} bytes=${byteLen}`
    );
  }
  /** 每 500 个转发包输出一次计数（避免逐包日志造成费用与噪音）。 */
  maybeLogStats(peerId, byteLen) {
    const now = Date.now();
    if (this.forwarded % 500 !== 0 || now - this.lastLogAt < 1e3) {
      return;
    }
    this.lastLogAt = now;
    console.log(
      `[mh-edge] stats room=${roomLogPrefix(this.roomHash)} peer=${peerId} bytes=${byteLen} forwarded=${this.forwarded} dropped=${this.dropped} rate_limited=${this.rateLimited} invalid=${this.invalid} oversize=${this.oversize} kicked=${this.kicked}`
    );
  }
};
function normalizeBinary(message) {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (ArrayBuffer.isView(message)) {
    const view = message;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
var WIRE_FRAME_LIMIT = MAX_WIRE_FRAME;
export {
  MeshRoom,
  WIRE_FRAME_LIMIT,
  index_default as default
};
