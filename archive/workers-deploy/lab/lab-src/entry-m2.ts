/** M2：M1 + 入口静态引用 `dial` 符号（唯一的差异）。 */
import { setConnectOverride, dial } from '../src/outbound/dial'
import { handleWebSocket } from '../src/protocols/websocket-self'

const dialRef = dial

export default {
  fetch(request: Request): Response {
    setConnectOverride(null)
    return new Response(
      typeof handleWebSocket === 'function' && typeof dialRef === 'function'
        ? 'm2-ok'
        : 'm2-bad',
      { status: 200 }
    )
  },
}
