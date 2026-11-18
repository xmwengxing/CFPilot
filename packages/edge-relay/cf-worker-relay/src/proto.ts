// P4.2：MobiHop 32B 线速头的**纯函数**协议逻辑。
//
// 本文件刻意不含任何 I/O / Cloudflare 绑定：帧头解析、转发决策、TTL 改写、
// 限速窗口都是可单测的纯函数（node --test 直接引用本 .ts）。
//
// 零知识纪律：
// - 只读 32B 头；载荷（`frame[32..]`）**只做长度校验与透传**，绝不解密 / 不解析；
// - 不把载荷内容传给日志（调用方只应记录 peer_id / 包长 / room 前 4 字符）。

export const MAGIC = 0x4d;
/** ADR-0016：v2 线速协议；v1 帧（0x01）仍接受一个发布周期。 */
export const VERSION = 0x02;
export const LEGACY_VERSION = 0x01;
export const HEADER_LEN = 32;
export const MAX_FRAME = 1400;
export const MAX_WIRE_FRAME = HEADER_LEN + MAX_FRAME; // 1432，与 Rust MAX_WIRE_FRAME 一致
export const BROADCAST_HEX = "ffffffffffffffff";

/** 32B 头偏移（与 `mobihop-proto/src/header.rs` 逐字节一致）。 */
export const OFF = {
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
  counter: 24,
} as const;

/** MobiHop 消息类型白名单（0x01..0x07；未知类型按 Rust `MessageType::try_from` 拒绝）。 */
export const MESSAGE_TYPES = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07] as const;

/** FLAG_RELAYED（bit1）：本帧经过中继。 */
export const FLAG_RELAYED = 0x02;

export interface ParsedFrame {
  /** 原始完整帧（32B 头 + 载荷）；本函数不复制、不修改它。 */
  readonly frame: Uint8Array;
  readonly msgType: number;
  readonly flags: number;
  readonly ttl: number;
  /** ADR-0016：原始 `key_meta` 字节（v1 恒为 0）。 */
  readonly keyMeta: number;
  /** 高 4 位 key_slot（0–15）。 */
  readonly keySlot: number;
  /** 低 4 位 qos_class（H2 只写 0）。 */
  readonly qosClass: number;
  readonly payloadLen: number;
  /** 源 / 目的 NodeId（小写 16 hex）。 */
  readonly src: string;
  readonly dst: string;
  readonly broadcast: boolean;
}

export type ParseResult =
  | { ok: true; frame: ParsedFrame }
  | { ok: false; reason: string };

/** 8 字节大端 NodeId → 16 位小写 hex。 */
function nodeIdHex(bytes: Uint8Array, offset: number): string {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    const byte = bytes[offset + i] ?? 0;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function fail(reason: string): ParseResult {
  return { ok: false, reason };
}

/**
 * 解析并严格校验一个完整 MobiHop 帧（一个 WS 二进制消息 = 一个完整帧）。
 *
 * 拒绝：超长、短于 32B、magic/version 不符（仅接受 v1 `0x01` 与 v2 `0x02`）、
 * v1 的保留字节非零、TTL 越界、未知消息类型、帧长与头部 `payload_len` 不符。
 */
export function parseFrame(input: Uint8Array): ParseResult {
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
  if (!(MESSAGE_TYPES as readonly number[]).includes(msgType)) {
    return fail("unknown_type");
  }
  const keyMeta = input[OFF.keyMeta] ?? 1;
  // v1：保留字节必须为 0；v2：任意 key_meta（中继不解密，只需透传）。
  if (isLegacy && keyMeta !== 0) {
    return fail("reserved_nonzero");
  }
  const ttl = input[OFF.ttl] ?? 0;
  if (ttl > 64) {
    return fail("ttl_out_of_range");
  }
  const payloadLen = ((input[OFF.payloadLen] ?? 0) << 8) | (input[OFF.payloadLen + 1] ?? 0);
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
      qosClass: keyMeta & 0x0f,
      payloadLen,
      src,
      dst,
      broadcast: dst === BROADCAST_HEX,
    },
  };
}

export type DropReason =
  | "ttl_exhausted"
  | "self_unicast"
  | "unknown_target"
  | "no_members"
  | "invalid_target";

export type ForwardDecision =
  | { kind: "unicast"; target: string }
  | { kind: "broadcast"; targets: string[] }
  | { kind: "drop"; reason: DropReason };

/**
 * 房间内转发决策（纯函数）：
 * - 单播：`Dst` 必须是房间内**其他** peer 的 peer_id；命中才转发；
 * - 广播（`Dst = 0xFF…`）：发给房间内**除发送方外**全部成员（排序稳定）；
 * - 自我单播 / 未知目标 / 空房间 / TTL 耗尽 → 丢弃并计数。
 */
export function decideForward(
  parsed: ParsedFrame,
  senderPeerId: string,
  peerIds: readonly string[],
): ForwardDecision {
  if (parsed.ttl <= 1) {
    return { kind: "drop", reason: "ttl_exhausted" };
  }
  if (parsed.broadcast) {
    const targets = peerIds
      .filter((peer) => peer !== senderPeerId)
      .slice()
      .sort();
    if (targets.length === 0) {
      return { kind: "drop", reason: "no_members" };
    }
    return { kind: "broadcast", targets };
  }
  if (parsed.dst === senderPeerId) {
    // 绝不反射回源地址（与 P2.2 盲中继「只向已登记成员发包 / 不反射」一致）。
    return { kind: "drop", reason: "self_unicast" };
  }
  if (!peerIds.includes(parsed.dst)) {
    return { kind: "drop", reason: "unknown_target" };
  }
  return { kind: "unicast", target: parsed.dst };
}

/**
 * 生成转发用帧：TTL 递减、置 `Relayed` 标志。
 *
 * **只改 32B 头中的逐跳可变字段**（ttl@4、flags@3）；载荷逐字节保持原样。
 * 这两个字段不参与 E2E AEAD 的 AAD（见 `Header::aad_bytes`），因此端到端解密不受影响。
 */
export function prepareForwardFrame(parsed: ParsedFrame): Uint8Array {
  const out = parsed.frame.slice();
  out[OFF.ttl] = parsed.ttl - 1;
  out[OFF.flags] = parsed.flags | FLAG_RELAYED;
  return out;
}

export interface RateLimits {
  /** 滑动窗口长度（毫秒）。 */
  readonly windowMs: number;
  /** 窗口内最大字节数。 */
  readonly maxBytes: number;
  /** 窗口内最大包数。 */
  readonly maxPackets: number;
}

export type RateResult =
  | { allowed: true }
  | { allowed: false; reason: "bytes" | "packets"; retryAfterMs: number };

/**
 * 每连接滑动窗口限速（字节 / 包数双限；语义同 P2.2 `QuotaWindow`）。
 *
 * 被拒绝的帧**不写入窗口**（与 Rust 中继一致：超限帧不计入已准入流量）。
 */
export class SlidingWindow {
  private entries: { ts: number; bytes: number }[] = [];
  private readonly limits: RateLimits;

  constructor(limits: RateLimits) {
    if (limits.windowMs <= 0 || limits.maxBytes <= 0 || limits.maxPackets <= 0) {
      throw new Error("invalid rate limits");
    }
    this.limits = limits;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.limits.windowMs;
    while (this.entries.length > 0 && (this.entries[0]?.ts ?? nowMs) <= cutoff) {
      this.entries.shift();
    }
  }

  allow(nowMs: number, bytes: number): RateResult {
    this.prune(nowMs);
    let usedBytes = 0;
    for (const entry of this.entries) {
      usedBytes += entry.bytes;
    }
    const oldest = this.entries[0]?.ts;
    const retryAfterMs =
      oldest === undefined ? this.limits.windowMs : Math.max(0, oldest + this.limits.windowMs - nowMs);
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
  usage(nowMs: number): { bytes: number; packets: number } {
    this.prune(nowMs);
    let bytes = 0;
    for (const entry of this.entries) {
      bytes += entry.bytes;
    }
    return { bytes, packets: this.entries.length };
  }
}

/** `peer_id` 必须是 16 位小写 hex（8 字节 NodeId）。 */
export function validatePeerId(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /^[0-9a-f]{16}$/.test(raw);
}

/** `network_hash` 白名单：8..64 位小写 hex（房间名由 PSK 派生，不含 '/' 等路径字符）。 */
export function validateNetworkHash(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /^[0-9a-f]{8,64}$/.test(raw);
}

/** 从 `/mesh/<network_hash>` 中提取房间名；非法返回 null。 */
export function networkHashFromPath(pathname: string): string | null {
  const match = /^\/mesh\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  const hash = match[1] ?? null;
  return validateNetworkHash(hash) ? hash : null;
}

/** 日志用的房间名前缀（**只允许前 4 字符**，不得输出完整 hash / 载荷）。 */
export function roomLogPrefix(networkHash: string): string {
  return networkHash.slice(0, 4);
}
