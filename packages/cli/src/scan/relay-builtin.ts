/**
 * 内置反代候选清单（随版本发布，**用户不可修改**）。
 *
 * ## 为什么要有内置清单
 *
 * 大多数用户手上没有自己的反代 IP 源。没有候选就没法跑「反代优选」，
 * 于是这个功能对他们是死的。内置一份实测过的清单，至少让首次使用能跑通。
 *
 * ## 为什么放在 assets 而不是写死在代码里
 *
 *   - 清单会随版本更新（每次发布重新实测、重新挑），写死在 .ts 里会让
 *     diff 变成几千行；
 *   - 桌面版要 go:embed 同一份文件，构建期从 `packages/cli/assets/` 复制过去，
 *     两边永远一致。
 *
 * ## 边界
 *
 * 这份清单**不接受用户修改**（用户要测自己的 IP 就用 `--file` / `--url`）；
 * 它只在我们发版时更新。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIpFile } from './ip-ranges'

/** 内置清单文件名（CLI 与桌面版共用同一份） */
export const BUILTIN_RELAY_FILE = 'relay-ip-builtin.txt'

/** 定位模块所在目录（ESM 用 import.meta，CJS 产物回退 __dirname） */
function moduleDir(): string {
  try {
    const meta = import.meta
    if (meta && typeof meta.url === 'string') return dirname(fileURLToPath(meta.url))
  } catch {
    /* CJS 产物：import.meta 不存在 */
  }
  return typeof __dirname === 'string' ? __dirname : process.cwd()
}

/**
 * 读取内置反代候选。
 *
 * 候选路径：
 *   - `../assets/`    npm 包内置资产（dist/cli.js 的同级）
 *   - `../../assets/` 源码目录（src/scan/）
 */
export function readBuiltinRelayCandidates(): string[] {
  const paths = [
    resolve(moduleDir(), `../assets/${BUILTIN_RELAY_FILE}`),
    resolve(moduleDir(), `../../assets/${BUILTIN_RELAY_FILE}`),
    resolve(process.cwd(), `packages/cli/assets/${BUILTIN_RELAY_FILE}`),
  ]
  for (const path of paths) {
    try {
      const list = readIpFile(readFileSync(path, 'utf8')).filter((ip) =>
        /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
      )
      if (list.length > 0) return list
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    `内置反代候选缺失（assets/${BUILTIN_RELAY_FILE}），请重新安装或升级 cfpilot；\n` +
      '也可以用自己的清单：--file <路径> 或 --url <链接>'
  )
}
