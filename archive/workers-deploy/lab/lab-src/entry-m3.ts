/** M3：dial 模块单独打包 + 静态引用 `dial` 符号（对应交接文档「dial 单独 200」的复验）。 */
import { dial } from '../src/outbound/dial'

const dialRef = dial

export default {
  fetch(request: Request): Response {
    return new Response(typeof dialRef === 'function' ? 'm3-ok' : 'm3-bad', { status: 200 })
  },
}
