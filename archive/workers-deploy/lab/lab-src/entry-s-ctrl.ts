/** S-ctrl：与 S 完全相同，但**去掉顶层 globalThis 写入** —— 对照组。 */
export default {
  fetch(request: Request): Response {
    return new Response('s-ctrl-ok', { status: 200 })
  },
}
