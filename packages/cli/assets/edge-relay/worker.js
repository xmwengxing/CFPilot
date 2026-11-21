// ../edge-relay/cf-worker-relay/dashboard.html
var dashboard_default = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MobiHop \u4E91\u76D1\u6D4B\u53F0</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#0b1220; color:#e2e8f0; }
  header { padding:16px 24px; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; }
  h1 { margin:0; font-size:18px; }
  .sub { color:#64748b; font-size:13px; }
  main { padding:24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:#111a2e; border:1px solid #1e293b; border-radius:10px; padding:14px; }
  .card .label { color:#64748b; font-size:12px; }
  .card .val { font-size:24px; font-weight:600; margin-top:4px; }
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:10px; }
  table { width:100%; min-width:720px; border-collapse:collapse; background:#111a2e; border:1px solid #1e293b; }
  th,td { padding:10px 12px; text-align:left; font-size:13px; border-bottom:1px solid #1e293b; white-space:nowrap; }
  th { color:#94a3b8; background:#0f172a; font-weight:500; }
  tr:last-child td { border-bottom:none; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .dot.on { background:#22c55e; box-shadow:0 0 6px #22c55e; }
  .dot.off { background:#475569; }
  .mono { font-family: ui-monospace, monospace; font-size:12px; }
  .err { color:#f87171; padding:12px; }
  .cfg { font-size:12px; color:#64748b; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  input { background:#0f172a; border:1px solid #334155; color:#e2e8f0; padding:6px 10px; border-radius:6px; font-size:13px; }
  button { background:#2563eb; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px; }
  button:hover { background:#1d4ed8; }
  button.ghost { background:#1e293b; }
  button.ghost:hover { background:#334155; }
  .auth-box { max-width:420px; margin:40px auto; background:#111a2e; border:1px solid #1e293b; border-radius:12px; padding:24px; }
  .auth-box h2 { margin:0 0 6px; font-size:18px; }
  .auth-box p { color:#64748b; font-size:13px; margin:0 0 16px; }
  .auth-box label { display:block; font-size:12px; color:#94a3b8; margin:12px 0 4px; }
  .auth-box input { width:100%; }
  .auth-box .row { display:flex; gap:8px; margin-top:16px; }
  .auth-box .row button { flex:1; }
  .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:50; }
  .modal { background:#111a2e; border:1px solid #1e293b; border-radius:12px; padding:24px; width:90%; max-width:420px; }
  .modal h3 { margin:0 0 12px; font-size:16px; }
  .modal label { display:block; font-size:12px; color:#94a3b8; margin:10px 0 4px; }
  .modal input { width:100%; }
  .modal .row { display:flex; gap:8px; margin-top:16px; justify-content:flex-end; }
  @media (max-width: 640px) {
    header { padding:12px 16px; }
    main { padding:16px; }
    .cfg input { width:100%; }
    h1 { font-size:16px; }
    .card .val { font-size:20px; }
  }
</style>
</head>
<body>
<header id="hdr" style="display:none">
  <div>
    <h1>MobiHop \u4E91\u76D1\u6D4B\u53F0</h1>
    <div class="sub">\u53EA\u8BFB\u76D1\u6D4B \xB7 \u8282\u70B9\u5FC3\u8DF3 \xB7 \u514D\u8D39\u6258\u7BA1</div>
  </div>
  <div class="cfg">
    API: <input id="api" /> <button onclick="saveApi()">\u4FDD\u5B58</button>
    <button class="ghost" onclick="openChangePw()">\u4FEE\u6539\u5BC6\u7801</button>
    <button class="ghost" onclick="logout()">\u9000\u51FA</button>
  </div>
</header>
<main>
  <div id="view-setup" class="auth-box" style="display:none">
    <h2>\u672A\u914D\u7F6E\u5BC6\u7801</h2>
    <p>\u76D1\u6D4B\u53F0\u5BC6\u7801\u5C1A\u672A\u521D\u59CB\u5316\u3002\u8BF7\u901A\u8FC7\u90E8\u7F72\u811A\u672C\uFF08deploy-cf.ps1\uFF09\u8BBE\u7F6E\u767B\u5F55\u5BC6\u7801\uFF0C\u6216\u8054\u7CFB\u7BA1\u7406\u5458\u3002</p>
    <p id="setup-err" class="err"></p>
  </div>
  <div id="view-login" class="auth-box" style="display:none">
    <h2>\u767B\u5F55</h2>
    <p>\u8BF7\u8F93\u5165\u76D1\u6D4B\u53F0\u5BC6\u7801\u3002</p>
    <label>\u5BC6\u7801</label>
    <input id="login-pw" type="password" onkeydown="if(event.key==='Enter')doLogin()" />
    <div class="row"><button onclick="doLogin()">\u767B\u5F55</button></div>
    <p id="login-err" class="err"></p>
  </div>
  <div id="view-app" style="display:none">
    <div class="grid">
      <div class="card"><div class="label">\u8BBE\u5907\u603B\u6570</div><div class="val" id="total">\u2014</div></div>
      <div class="card"><div class="label">\u5728\u7EBF</div><div class="val" id="online">\u2014</div></div>
      <div class="card"><div class="label">\u79BB\u7EBF</div><div class="val" id="offline">\u2014</div></div>
      <div class="card"><div class="label">\u6700\u540E\u5237\u65B0</div><div class="val" id="refresh" style="font-size:14px">\u2014</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>\u72B6\u6001</th><th>\u8BBE\u5907</th><th>Node ID</th><th>\u865A\u62DF IP</th><th>\u7248\u672C</th><th>\u6700\u540E IP</th><th>\u6700\u540E\u5FC3\u8DF3</th></tr></thead>
        <tbody id="rows"><tr><td colspan="7" style="text-align:center;color:#64748b">\u52A0\u8F7D\u4E2D\u2026</td></tr></tbody>
      </table>
    </div>
    <p id="err" class="err"></p>
  </div>
</main>
<div id="modal" style="display:none"></div>
<script>
  const DEFAULT_API = location.origin;
  const apiInput = document.getElementById('api');
  if (apiInput) apiInput.value = localStorage.getItem('monitor_api') || DEFAULT_API;
  function saveApi(){ if(apiInput) localStorage.setItem('monitor_api', apiInput.value); load(); }
  function apiUrl(){ const el=document.getElementById('api'); const v = el? el.value : (localStorage.getItem('monitor_api')||DEFAULT_API); return (v||DEFAULT_API).replace(/\\/+$/,''); }
  function token(){ return localStorage.getItem('monitor_session') || ''; }
  function setToken(t){ if(t) localStorage.setItem('monitor_session', t); else localStorage.removeItem('monitor_session'); }
  function fmtTime(ms){ if(!ms) return '\u2014'; return new Date(ms).toLocaleString('zh-CN',{hour12:false}); }
  function show(id){ ['view-setup','view-login','view-app'].forEach(v=>{ const e=document.getElementById(v); if(e) e.style.display = v===id?'block':'none'; }); const hdr=document.getElementById('hdr'); if(hdr) hdr.style.display = id==='view-app'?'flex':'none'; }
  async function apiFetch(path, opts){ opts=opts||{}; opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{}); const t=token(); if(t) opts.headers['Authorization']='Bearer '+t; const r=await fetch(apiUrl()+path, opts); return r; }

  async function init(){
    try {
      const r = await fetch(apiUrl()+'/auth/status');
      const d = await r.json();
      if (d.setupRequired) { show('view-setup'); }
      else if (!token()) { show('view-login'); }
      else { show('view-app'); load(); }
    } catch(e){ document.getElementById('login-err').textContent='\u8FDE\u63A5\u5931\u8D25: '+e.message; show('view-login'); }
  }

  async function doSetup(){ /* disabled: password must be set via deploy script */ }

  async function doLogin(){
    const pw=document.getElementById('login-pw').value;
    const err=document.getElementById('login-err');
    err.textContent='';
    try {
      const r=await fetch(apiUrl()+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
      const d=await r.json();
      if(!r.ok){ err.textContent=d.message||'\u767B\u5F55\u5931\u8D25'; return; }
      setToken(d.token); show('view-app'); load();
    } catch(e){ err.textContent='\u5931\u8D25: '+e.message; }
  }

  async function logout(){
    try { await apiFetch('/auth/logout',{method:'POST'}); } catch(e){}
    setToken(''); show('view-login');
  }

  function openChangePw(){
    const m=document.getElementById('modal');
    m.style.display='flex';
    m.innerHTML = \`<div class="modal">
      <h3>\u4FEE\u6539\u5BC6\u7801</h3>
      <label>\u65E7\u5BC6\u7801</label><input id="cp-old" type="password" />
      <label>\u65B0\u5BC6\u7801\uFF08\u81F3\u5C11 8 \u4F4D\uFF09</label><input id="cp-new" type="password" />
      <label>\u786E\u8BA4\u65B0\u5BC6\u7801</label><input id="cp-new2" type="password" />
      <p id="cp-err" class="err"></p>
      <div class="row"><button class="ghost" onclick="closeModal()">\u53D6\u6D88</button><button onclick="doChangePw()">\u786E\u8BA4</button></div>
    </div>\`;
  }
  function closeModal(){ const m=document.getElementById('modal'); m.style.display='none'; m.innerHTML=''; }
  async function doChangePw(){
    const oldPw=document.getElementById('cp-old').value;
    const newPw=document.getElementById('cp-new').value;
    const newPw2=document.getElementById('cp-new2').value;
    const err=document.getElementById('cp-err');
    err.textContent='';
    if(newPw.length<8){ err.textContent='\u65B0\u5BC6\u7801\u81F3\u5C11 8 \u4F4D'; return; }
    if(newPw!==newPw2){ err.textContent='\u4E24\u6B21\u65B0\u5BC6\u7801\u4E0D\u4E00\u81F4'; return; }
    try {
      const r=await apiFetch('/auth/change-password',{method:'POST',body:JSON.stringify({oldPassword:oldPw,newPassword:newPw})});
      const d=await r.json();
      if(!r.ok){ err.textContent=d.message||'\u4FEE\u6539\u5931\u8D25'; return; }
      closeModal();
      alert('\u5BC6\u7801\u5DF2\u4FEE\u6539\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55');
      logout();
    } catch(e){ err.textContent='\u5931\u8D25: '+e.message; }
  }

  async function load(){
    const err = document.getElementById('err');
    err.textContent = '';
    try {
      const r = await apiFetch('/devices');
      if(r.status===401){ setToken(''); show('view-login'); return; }
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const devs = data.devices || [];
      document.getElementById('total').textContent = devs.length;
      const on = devs.filter(d=>d.online).length;
      document.getElementById('online').textContent = on;
      document.getElementById('offline').textContent = devs.length - on;
      document.getElementById('refresh').textContent = fmtTime(data.generatedAtMs);
      const tbody = document.getElementById('rows');
      if(devs.length===0){ tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b">\u6682\u65E0\u8BBE\u5907\u3002\u8282\u70B9\u9700\u914D\u7F6E monitoring \u4E0A\u62A5\u3002</td></tr>'; return; }
      tbody.innerHTML = devs.map(d => \`<tr>
        <td><span class="dot \${d.online?'on':'off'}"></span>\${d.online?'\u5728\u7EBF':'\u79BB\u7EBF'}</td>
        <td>\${d.alias||'\u2014'}</td>
        <td class="mono">\${d.nodeId}</td>
        <td class="mono">\${d.virtualIpv4||'\u2014'}</td>
        <td>\${d.version||'\u2014'}</td>
        <td class="mono">\${d.lastIp||'\u2014'}</td>
        <td>\${fmtTime(d.lastSeenMs)}</td>
      </tr>\`).join('');
    } catch(e){ err.textContent = '\u52A0\u8F7D\u5931\u8D25: ' + e.message; }
  }

  init();
  setInterval(()=>{ if(document.getElementById('view-app').style.display!=='none') load(); }, 15000);
</script>
</body>
</html>
`;

// ../edge-relay/cf-worker-relay/src/proto.ts
var MAGIC = 77;
var VERSION = 2;
var LEGACY_VERSION = 1;
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
  /** ADR-0016：v2 中为 `key_meta`（高 4 位 key_slot / 低 4 位 qos_class），v1 必须为 0。 */
  keyMeta: 5,
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
  const version = input[OFF.version];
  if (version !== VERSION && version !== LEGACY_VERSION) {
    return fail("bad_version");
  }
  const isLegacy = version === LEGACY_VERSION;
  const msgType = input[OFF.msgType] ?? 0;
  if (!MESSAGE_TYPES.includes(msgType)) {
    return fail("unknown_type");
  }
  const keyMeta = input[OFF.keyMeta] ?? 1;
  if (isLegacy && keyMeta !== 0) {
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
      keyMeta,
      keySlot: keyMeta >> 4,
      qosClass: keyMeta & 15,
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
    if (path === "/" && request.method === "GET" && !isWebSocketUpgrade(request)) {
      return new Response(dashboard_default, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
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
