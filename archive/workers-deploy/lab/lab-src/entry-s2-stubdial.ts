/** S2：websocket-self + dial 的**桩**（dial 模块完全不进产物）—— 检验 dial 模块顶层是否致命。 */
import { handleWebSocket } from '../src/protocols/websocket-self'

// 桩：模拟 setConnectOverride，不引入 dial 模块
let override: unknown = null
const setConnectOverride = (fn: unknown): void => {
  override = fn
}

export default {
  fetch(request: Request): Response {
    setConnectOverride(null)
    void override
    return new Response(typeof handleWebSocket === 'function' ? 's2-ok' : 's2-bad', {
      status: 200,
    })
  },
}
