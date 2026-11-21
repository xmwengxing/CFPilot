// P4.2：Worker 路由与 Durable Object 转发语义的 Node 单测（用内存 fake 替代 workerd）。
//
// 不依赖 Cloudflare 运行时：Worker 用 plain object 模拟 Request；DO 用 FakeState /
// FakeWebSocket 模拟 Hibernation API（acceptWebSocket / getWebSockets / getTags）。
// 运行：node --test test/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".html")) {
      const source = `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`;
      return { format: "module", shortCircuit: true, source };
    }
    return nextLoad(url, context);
  },
});

const { default: worker, MeshRoom } = await import("../src/index.ts");
import {
  BROADCAST_HEX,
  HEADER_LEN,
  MAGIC,
  VERSION,
} from "../src/proto.ts";

function writeHex(frame, offset, hex) {
  for (let i = 0; i < 8; i += 1) {
    frame[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

/** 构造一个 Data 帧（32B 头 + 载荷）。 */
function dataFrame({ src, dst, payload = new Uint8Array([0x53, 0x45, 0x43]), ttl = 8 }) {
  const frame = new Uint8Array(HEADER_LEN + payload.length);
  frame[0] = MAGIC;
  frame[1] = VERSION;
  frame[2] = 0x04; // Data
  frame[3] = 0x01; // Encrypted
  frame[4] = ttl;
  frame[6] = 0;
  frame[7] = payload.length;
  writeHex(frame, 8, src);
  writeHex(frame, 16, dst);
  frame.set(payload, HEADER_LEN);
  return frame;
}

/** 模拟 DurableObjectState（Hibernation API 的最小内存版）。 */
class FakeState {
  constructor() {
    this.sockets = [];
    this.tags = new Map();
  }

  acceptWebSocket(ws, tags = []) {
    this.sockets.push(ws);
    this.tags.set(ws, tags);
  }

  getWebSockets(tag) {
    if (tag === undefined) {
      return [...this.sockets];
    }
    return this.sockets.filter((ws) => (this.tags.get(ws) ?? []).includes(tag));
  }

  getTags(ws) {
    return this.tags.get(ws) ?? [];
  }
}

class FakeWebSocket {
  constructor(tag) {
    this.tag = tag;
    this.sent = [];
    this.closeInfo = null;
  }

  send(frame) {
    this.sent.push(frame);
  }

  close(code, reason) {
    this.closeInfo = { code, reason };
  }
}

function addPeer(state, tag) {
  const ws = new FakeWebSocket(tag);
  state.acceptWebSocket(ws, [tag]);
  return ws;
}

function makeRoom(state, env = {}) {
  return new MeshRoom(state, {
    WINDOW_MS: "1000",
    MAX_BYTES_PER_WINDOW: "1048576",
    MAX_PACKETS_PER_WINDOW: "2000",
    MAX_PEERS_PER_ROOM: "16",
    ...env,
  });
}

function asArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("Worker 路由：合法 upgrade → 按 network_hash 取同名 DO", async () => {
  const calls = [];
  const env = {
    MESH_ROOM: {
      idFromName: (name) => {
        calls.push(name);
        return `id:${name}`;
      },
      get: () => ({
        fetch: async () => new Response("upgraded", { status: 200 }),
      }),
    },
  };
  const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const req = {
    method: "GET",
    url: `https://edge.example.com/mesh/${hash}?peer_id=0011223344556677`,
    headers: { get: (name) => (name.toLowerCase() === "upgrade" ? "websocket" : null) },
  };
  const resp = await worker.fetch(req, env);
  assert.equal(resp.status, 200);
  assert.deepEqual(calls, [hash], "必须按 network_hash 取 DO 实例（房间隔离）");
});

test("Worker 根路径返回监测台，默认 API 使用当前域名", async () => {
  const env = { MESH_ROOM: { idFromName: () => "x", get: () => ({ fetch: async () => new Response("") }) } };
  const req = {
    method: "GET",
    url: "https://edge.example.com/",
    headers: { get: () => null },
  };

  const resp = await worker.fetch(req, env);
  const html = await resp.text();

  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("Content-Type"), /text\/html/);
  assert.equal(resp.headers.get("Cache-Control"), "no-store");
  assert.match(html, /const DEFAULT_API = location\.origin/);
});

test("Worker 路由：非法 peer_id / 路径 / 非 upgrade 一律拒绝", async () => {
  const env = { MESH_ROOM: { idFromName: () => "x", get: () => ({ fetch: async () => new Response("") }) } };
  const upgrade = (url, upgrade = "websocket") => ({
    method: "GET",
    url,
    headers: { get: (name) => (name.toLowerCase() === "upgrade" ? upgrade : null) },
  });

  assert.equal((await worker.fetch(upgrade("https://e/mesh/01234567?peer_id=xyz"), env)).status, 400);
  assert.equal((await worker.fetch(upgrade("https://e/mesh/ABC?peer_id=0011223344556677"), env)).status, 400);
  assert.equal((await worker.fetch(upgrade("https://e/mesh/01234567/extra?peer_id=0011223344556677"), env)).status, 400);
  assert.equal((await worker.fetch(upgrade("https://e/mesh/01234567?peer_id=0011223344556677", ""), env)).status, 426);
});

test("DO 单播：按 dst peer_id 精确转发，且只改 ttl/flags、载荷不变", () => {
  const state = new FakeState();
  const room = makeRoom(state);
  const a = addPeer(state, "aaaaaaaaaaaaaaaa");
  const b = addPeer(state, "bbbbbbbbbbbbbbbb");
  const c = addPeer(state, "cccccccccccccccc");
  const payload = new Uint8Array([0x53, 0x45, 0x43, 0x52, 0x45, 0x54]);
  const frame = dataFrame({ src: "aaaaaaaaaaaaaaaa", dst: "bbbbbbbbbbbbbbbb", payload });

  room.webSocketMessage(a, asArrayBuffer(frame));

  assert.equal(b.sent.length, 1);
  assert.equal(c.sent.length, 0, "单播不得发给其它房间成员");
  const out = b.sent[0];
  assert.equal(out[3], 0x03, "Relayed 位");
  assert.equal(out[4], 7, "TTL 递减");
  assert.deepEqual(out.subarray(HEADER_LEN), payload, "载荷逐字节原样转发");
  // 发送方不得收到自己的帧。
  assert.equal(a.sent.length, 0);
});

test("DO 广播：房间内除发送方外全部转发", () => {
  const state = new FakeState();
  const room = makeRoom(state);
  const a = addPeer(state, "aaaaaaaaaaaaaaaa");
  const b = addPeer(state, "bbbbbbbbbbbbbbbb");
  const c = addPeer(state, "cccccccccccccccc");
  const frame = dataFrame({ src: "aaaaaaaaaaaaaaaa", dst: BROADCAST_HEX });

  room.webSocketMessage(a, asArrayBuffer(frame));
  assert.equal(a.sent.length, 0, "广播绝不反射回发送方");
  assert.equal(b.sent.length, 1);
  assert.equal(c.sent.length, 1);
});

test("DO 丢弃未知目标 / 自我单播 / 畸形帧", () => {
  const state = new FakeState();
  const room = makeRoom(state);
  const a = addPeer(state, "aaaaaaaaaaaaaaaa");
  const b = addPeer(state, "bbbbbbbbbbbbbbbb");
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    room.webSocketMessage(a, asArrayBuffer(dataFrame({ src: "aaaaaaaaaaaaaaaa", dst: "dddddddddddddddd" })));
    assert.equal(b.sent.length, 0);
    room.webSocketMessage(a, asArrayBuffer(dataFrame({ src: "aaaaaaaaaaaaaaaa", dst: "aaaaaaaaaaaaaaaa" })));
    assert.equal(b.sent.length, 0);
    // 坏 magic。
    const bad = dataFrame({ src: "aaaaaaaaaaaaaaaa", dst: "bbbbbbbbbbbbbbbb" });
    bad[0] = 0x00;
    room.webSocketMessage(a, asArrayBuffer(bad));
    assert.equal(b.sent.length, 0);
    // 文本消息（协议只接受二进制）。
    room.webSocketMessage(a, "hello");
    assert.equal(b.sent.length, 0);
  } finally {
    console.log = orig;
  }
  // 日志只含元数据，不得出现载荷内容（这里 payload 含 SECRET）。
  for (const line of logs) {
    assert.equal(line.includes("SECRET"), false, `日志泄露载荷: ${line}`);
    assert.equal(line.includes("53 45 43"), false);
  }
});

test("DO 限速：每连接包数上限触发后丢弃并计数（不再转发）", () => {
  const state = new FakeState();
  const room = makeRoom(state, { MAX_PACKETS_PER_WINDOW: "2" });
  const a = addPeer(state, "aaaaaaaaaaaaaaaa");
  const b = addPeer(state, "bbbbbbbbbbbbbbbb");
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    for (let i = 0; i < 3; i += 1) {
      const frame = dataFrame({ src: "aaaaaaaaaaaaaaaa", dst: "bbbbbbbbbbbbbbbb" });
      frame[24 + 7] = i; // 变换 counter，避免去重（本实现无去重，仅示意）
      room.webSocketMessage(a, asArrayBuffer(frame));
    }
  } finally {
    console.log = orig;
  }
  assert.equal(b.sent.length, 2, "第 3 帧必须被限速丢弃");
  assert.ok(logs.some((line) => line.includes("rate_limited")), "限速必须计数并有节流日志");
});

test("DO 单房间连接上限由 env 控制（fetch 路径）", async () => {
  // 用 fake Request + fake WebSocketPair 验证容量拒绝（不依赖 workerd）。
  const state = new FakeState();
  const room = makeRoom(state, { MAX_PEERS_PER_ROOM: "1" });
  addPeer(state, "aaaaaaaaaaaaaaaa");
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new FakeWebSocket("client");
      this[1] = new FakeWebSocket("server");
    }
  };
  const req = {
    method: "GET",
    url: "https://edge.example.com/mesh/01234567?peer_id=bbbbbbbbbbbbbbbb",
    headers: { get: (name) => (name.toLowerCase() === "upgrade" ? "websocket" : null) },
  };
  const resp = await room.fetch(req);
  assert.equal(resp.status, 503, "超过单房间连接上限必须拒绝");
});
