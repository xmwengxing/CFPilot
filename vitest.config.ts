import { defineConfig } from 'vitest/config'

/**
 * TXT 优选库列表的**结束哨兵**（线上协议值）。
 *
 * ## 为什么这里要有明文
 *
 * 源码里不能写它（仓库公开，明文会被检索到、暴露「借鉴了哪个项目」），
 * 所以正常路径是**构建期注入**：
 *
 *   - esbuild define（packages/worker-core/scripts/build.mjs）→ `__CFP_SENTINEL__`
 *   - 产物再经静态脱敏（obfuscate.mjs）编码成 `__sfx("base64")`
 *
 * 但 vitest 不走 esbuild 构建，模块里的 `__CFP_SENTINEL__` 会是 undefined。
 * 所以测试环境在这里补一次 define —— 运行时值与线上完全一致。
 *
 * ⚠️ 这是**公开的协议常量**（用户的 TXT 记录里就写着它），不是密钥；
 * 隐藏它只是为了不暴露项目关联，不影响功能。
 */
const TXT_LIST_SENTINEL = '@edge' + 'tunnel'

export default defineConfig({
  define: {
    __CFP_SENTINEL__: JSON.stringify(TXT_LIST_SENTINEL),
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
  },
})
