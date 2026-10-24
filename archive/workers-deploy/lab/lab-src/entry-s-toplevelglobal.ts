/** S：微型对照 —— 除了「isolate 启动阶段写 globalThis」外没有任何别的东西。 */
const g = globalThis as unknown as { __cfpLabTest?: () => number }
if (typeof g.__cfpLabTest !== 'function') g.__cfpLabTest = () => 42

export default {
  fetch(request: Request): Response {
    const fn = (globalThis as unknown as { __cfpLabTest?: () => number }).__cfpLabTest
    return new Response(typeof fn === 'function' && fn() === 42 ? 's-ok' : 's-bad', {
      status: 200,
    })
  },
}
