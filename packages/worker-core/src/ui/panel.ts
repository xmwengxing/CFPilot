/**
 * 面板 HTML 的运行时解包
 *
 * 面板以 gzip + Base64 的形式内嵌在核心里（见 scripts/gen-panel.mjs），
 * 这样才能把 worker-core 控制在 50KB 体积预算之内。
 * 解压只在第一次请求面板时发生一次，结果缓存在模块级变量中。
 */
import { PANEL_HTML_GZIP_B64 } from './panel.generated'

let cached: string | null = null

/** Base64 → 字节数组 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 取面板 HTML（首次调用时解压并缓存） */
export async function getPanelHtml(): Promise<string> {
  if (cached !== null) return cached
  const compressed = base64ToBytes(PANEL_HTML_GZIP_B64)
  const stream = new Response(compressed).body
  if (!stream) throw new Error('面板数据损坏')
  const decompressed = stream.pipeThrough(new DecompressionStream('gzip'))
  cached = await new Response(decompressed).text()
  return cached
}
