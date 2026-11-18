// P4.2：边缘盲中继协议纯函数单测（零依赖，`node --test` 直接运行）。
//
// 运行：cd edge/cf-worker-relay && node --test test/*.test.mjs
// （Node >=22.18 可直接 import `.ts` 源码；本机 Node 26 已实测。）

import assert from "node:assert/strict";
import test from "node:test";

import {
  BROADCAST_HEX,
  HEADER_LEN,
  MAGIC,
  MAX_FRAME,
  MAX_WIRE_FRAME,
  LEGACY_VERSION,
  SlidingWindow,
  VERSION,
  decideForward,
  networkHashFromPath,
  parseFrame,
  prepareForwardFrame,
  roomLogPrefix,
  validateNetworkHash,
  validatePeerId,
} from "../src/proto.ts";

const src = "0102030405060708";
const dst = "1112131415161718";
const broadcast = BROADCAST_HEX;

/** 构造一个合法帧（32B 头 + 任意载荷）。 */
function buildFrame(opts = {}) {
  const {
    magic = MAGIC,
    version = VERSION,
    msgType = 0x04,
    flags = 0,
    ttl = 8,
    reserved = 0,
    keyMeta = 0,
    payload = new TextEncoder().encode("payload"),
    srcHex = src,
    dstHex = dst,
    declaredPayloadLen = null,
    counter = 1n,
  } = opts;
  const payloadLen = declaredPayloadLen ?? payload.length;
  const frame = new Uint8Array(HEADER_LEN + payload.length);
  frame[0] = magic;
  frame[1] = version;
  frame[2] = msgType;
  frame[3] = flags;
  frame[4] = ttl;
  frame[5] = keyMeta || reserved;
  frame[6] = (payloadLen >> 8) & 0xff;
  frame[7] = payloadLen & 0xff;
  writeHex(frame, 8, srcHex);
  writeHex(frame, 16, dstHex);
  let counterValue = counter;
  for (let i = 31; i >= 24; i -= 1) {
    frame[i] = Number(counterValue & 0xffn);
    counterValue >>= 8n;
  }
  frame.set(payload, HEADER_LEN);
  return frame;
}

function writeHex(frame, offset, hex) {
  for (let i = 0; i < 8; i += 1) {
    frame[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

function parseOk(frame) {
  const parsed = parseFrame(frame);
  assert.equal(parsed.ok, true, `期望解析成功，实际 ${JSON.stringify(parsed)}`);
  return parsed.frame;
}

test("parseFrame 接受合法单播帧并只读头部", () => {
  const payload = new TextEncoder().encode("not-a-header");
  const frame = buildFrame({ payload, msgType: 0x04, ttl: 8 });
  const parsed = parseOk(frame);
  assert.equal(parsed.src, src);
  assert.equal(parsed.dst, dst);
  assert.equal(parsed.broadcast, false);
  assert.equal(parsed.payloadLen, payload.length);
  assert.equal(parsed.msgType, 0x04);
  // 解析不得改写载荷（零知识：只读头）。
  assert.deepEqual(frame.subarray(HEADER_LEN), payload);
});

test("parseFrame 识别广播 Dst=0xFF…", () => {
  const parsed = parseOk(buildFrame({ dstHex: broadcast }));
  assert.equal(parsed.broadcast, true);
});

test("parseFrame 拒绝畸形帧", () => {
  const cases = [
    ["bad_magic", buildFrame({ magic: 0x4e })],
    ["bad_version", buildFrame({ version: 0x03 })],
    ["unknown_type", buildFrame({ msgType: 0x08 })],
    // v1 帧的保留字节仍必须为 0（v2 才允许 key_meta）。
    ["reserved_nonzero", buildFrame({ version: LEGACY_VERSION, reserved: 1 })],
    ["ttl_out_of_range", buildFrame({ ttl: 65 })],
    ["length_mismatch", buildFrame({ declaredPayloadLen: 3 })],
    ["short", new Uint8Array(HEADER_LEN - 1)],
  ];
  for (const [reason, frame] of cases) {
    const parsed = parseFrame(frame);
    assert.equal(parsed.ok, false, reason);
    assert.equal(parsed.reason, reason);
  }
  // 超长：1433 > MAX_WIRE_FRAME(1432)。
  const oversize = new Uint8Array(MAX_WIRE_FRAME + 1);
  assert.equal(parseFrame(oversize).ok, false);
  assert.equal(parseFrame(oversize).reason, "oversize");
});

test("parseFrame 边界：恰好 MAX_WIRE_FRAME 可接受", () => {
  const payload = new Uint8Array(MAX_FRAME);
  const frame = buildFrame({ payload });
  assert.equal(frame.length, MAX_WIRE_FRAME);
  assert.equal(parseFrame(frame).ok, true);
});

test("decideForward：单播命中 / 未命中 / 自我单播", () => {
  const peers = [src, dst, "2222222222222222"];
  const parsed = parseOk(buildFrame({ dstHex: dst }));
  assert.deepEqual(decideForward(parsed, src, peers), { kind: "unicast", target: dst });

  const missing = "3333333333333333";
  const miss = parseOk(buildFrame({ dstHex: missing }));
  assert.deepEqual(decideForward(miss, src, peers), {
    kind: "drop",
    reason: "unknown_target",
  });

  const self = parseOk(buildFrame({ dstHex: src }));
  assert.deepEqual(decideForward(self, src, peers), {
    kind: "drop",
    reason: "self_unicast",
  });
});

test("decideForward：广播扇出排除发送方且稳定排序", () => {
  const peers = ["3333333333333333", src, "2222222222222222", dst];
  const parsed = parseOk(buildFrame({ dstHex: broadcast }));
  assert.deepEqual(decideForward(parsed, src, peers), {
    kind: "broadcast",
    targets: ["2222222222222222", "3333333333333333", dst].sort(),
  });

  // 房间只有发送方自己 ⇒ 不产生回声。
  assert.deepEqual(decideForward(parsed, src, [src]), {
    kind: "drop",
    reason: "no_members",
  });
});

test("decideForward：TTL<=1 一律丢弃", () => {
  for (const ttl of [0, 1]) {
    const parsed = parseOk(buildFrame({ ttl, dstHex: dst }));
    assert.deepEqual(decideForward(parsed, src, [src, dst]), {
      kind: "drop",
      reason: "ttl_exhausted",
    });
  }
});

test("prepareForwardFrame：只改 ttl/flags，载荷逐字节不变", () => {
  const payload = new TextEncoder().encode("SECRET-IP-PACKET");
  const frame = buildFrame({ payload, ttl: 8, flags: 0x01 /* encrypted */ });
  const parsed = parseOk(frame);
  const out = prepareForwardFrame(parsed);
  assert.equal(out.length, frame.length);
  assert.equal(out[4], 7, "TTL 必须递减");
  assert.equal(out[3], 0x03, "Relayed 位必须置位（保留 encrypted）");
  assert.deepEqual(out.subarray(HEADER_LEN), payload, "载荷不得被改写/解密");
  // 原帧不被就地修改。
  assert.equal(frame[4], 8);
});

test("SlidingWindow：字节 / 包数双维限速与窗口恢复", () => {
  const window = new SlidingWindow({ windowMs: 1000, maxBytes: 100, maxPackets: 2 });
  assert.deepEqual(window.allow(0, 40), { allowed: true });
  assert.deepEqual(window.allow(0, 40), { allowed: true });
  // 第三帧取 10 字节：字节合计 90 <= 100，先命中包数上限。
  const packets = window.allow(0, 10);
  assert.equal(packets.allowed, false);
  assert.equal(packets.reason, "packets");

  // 被拒帧不得消耗配额（包数仍为 2）。
  assert.equal(window.allow(0, 10).reason, "packets");

  // 窗口外恢复（最旧记录滑出）。
  assert.deepEqual(window.allow(1001, 40), { allowed: true });

  // 字节维。
  const bytesOnly = new SlidingWindow({ windowMs: 1000, maxBytes: 100, maxPackets: 100 });
  assert.equal(bytesOnly.allow(0, 99).allowed, true);
  const bytes = bytesOnly.allow(0, 2);
  assert.equal(bytes.allowed, false);
  assert.equal(bytes.reason, "bytes");
  assert.ok(bytes.retryAfterMs >= 0);
  assert.deepEqual(bytesOnly.usage(0), { bytes: 99, packets: 1 });
});

test("peer_id / network_hash 白名单", () => {
  assert.equal(validatePeerId("0123456789abcdef"), true);
  for (const bad of ["", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "zzzzzzzzzzzzzzzz", null, undefined]) {
    assert.equal(validatePeerId(bad), false, String(bad));
  }

  assert.equal(validateNetworkHash("a".repeat(8)), true);
  assert.equal(validateNetworkHash("f".repeat(64)), true);
  for (const bad of ["", "a".repeat(7), "a".repeat(65), "A".repeat(8), "../mesh", "abc/def", null]) {
    assert.equal(validateNetworkHash(bad), false, String(bad));
  }

  assert.equal(networkHashFromPath("/mesh/0123456789abcdef"), "0123456789abcdef");
  assert.equal(networkHashFromPath("/mesh/0123456789abcdef/extra"), null);
  assert.equal(networkHashFromPath("/other/0123456789abcdef"), null);
  assert.equal(roomLogPrefix("0123456789abcdef"), "0123");
});
