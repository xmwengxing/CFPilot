/**
 * 出站连接的流式读写辅助
 */
import { ByteStream } from '../protocols/stream'

/** 读取直到出现分隔符，返回包含分隔符在内的数据 */
export async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: Uint8Array,
  maxBytes = 8192
): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const collected: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      collected.push(value)
      total += value.byteLength
      if (total >= maxBytes) break
      const joined = concat(collected)
      if (indexOf(joined, marker) >= 0) break
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
  if (total === 0) return null
  return concat(collected)
}

/** 合并字节块 */
export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** 在字节数组中查找子串位置，未找到返回 -1 */
export function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** 创建一个写端（绑定到 socket 的 writable） */
export function writerOf(writable: WritableStream<Uint8Array>): WritableStreamDefaultWriter<Uint8Array> {
  return writable.getWriter()
}

/** 读取 socket 上的全部剩余数据（握手后交给上层继续使用） */
export function streamReader(stream: ReadableStream<Uint8Array>): ByteStream {
  return new ByteStream(stream)
}
