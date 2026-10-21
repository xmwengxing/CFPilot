/**
 * 中性页面：对外看起来就是一个普通静态网站。
 *
 * 任何未匹配路径都返回它，避免暴露 Worker JSON 指纹；500 也走这里，
 * 绝不把异常冒到边缘变成 Error 1101。
 */
export function neutralPage(status: 200 | 404 | 500): Response {
  const title = status === 200 ? 'Welcome' : status === 404 ? 'Not Found' : 'Service Unavailable'
  const body =
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:#f7f8fa;color:#333;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}` +
    `.c{text-align:center}h1{font-size:22px;font-weight:600;margin:0 0 10px}` +
    `p{color:#888;font-size:14px;margin:0}</style></head><body><div class="c">` +
    `<h1>${title}</h1><p>This site is up and running.</p></div></body></html>`
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** JSON 错误响应（仅用于 API/订阅等确实需要结构化错误的地方） */
export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
