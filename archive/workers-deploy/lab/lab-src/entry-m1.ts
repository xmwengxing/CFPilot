/** M1：最小化 —— dial 只经 `setConnectOverride` 静态引入，入口不引用 `dial` 符号。 */
import { setConnectOverride } from '../src/outbound/dial'
import { handleWebSocket } from '../src/protocols/websocket-self'

export default {
  fetch(request: Request): Response {
    setConnectOverride(null)
    return new Response(
      typeof handleWebSocket === 'function' ? 'm1-ok' : 'm1-bad',
      { status: 200 }
    )
  },
}
