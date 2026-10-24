// 实验转发器（旧账号，最简内容类）：由 Cloudflare 云端 fetch 目标 URL，回传状态码与响应体。
// 目的：绕过本机对 workers.dev 的网络封锁，探测**干净账号**上脚本的真实 HTTP 状态。
// 白名单：仅允许 *.xialinghuang08.workers.dev（干净账号）与 lab522*.xmdongyao.de5.net（通道自校验）。
export default {
  async fetch(request) {
    const u = new URL(request.url)
    const target = u.searchParams.get('u')
    if (!target) return new Response('relay-ok', { status: 200 })
    let t
    try {
      t = new URL(target)
    } catch {
      return new Response('relay-bad-url', { status: 400 })
    }
    const host = t.hostname
    const allowed =
      host.endsWith('.workers.dev') ||
      /^lab522[a-z]*\.xmdongyao\.de5\.net$/.test(host)
    if (!allowed || t.protocol !== 'https:') {
      return new Response('relay-forbidden', { status: 403 })
    }
    try {
      const r = await fetch(t.toString(), {
        redirect: 'manual',
        headers: { 'User-Agent': 'cfp-relay-lab' },
      })
      const body = await r.text()
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Relay-Origin-Status': String(r.status),
        },
      })
    } catch (err) {
      return new Response('relay-fetch-error: ' + String(err), {
        status: 200,
        headers: { 'X-Relay-Origin-Status': '000' },
      })
    }
  },
}
