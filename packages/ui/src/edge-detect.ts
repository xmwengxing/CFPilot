/**
 * 「检测部署状态」（盲中继 / 云监测台）的纯逻辑。
 *
 * 抽出成独立模块是为了能在 node 环境直接单测：renderer 只负责 DOM 回填，
 * 「多个实例时选哪个」这种容易出错、又不好用肉眼验证的判断放在这里。
 */

/** 与 globals.d.ts 的 CFPilotEdgeRelayInstance 保持结构兼容（只取用到的字段）。 */
export interface EdgeInstancePickable {
  workerName: string
  domain: string
}

export interface EdgePickHint {
  /** 页面里已经填过的域名（用户可能正对着某个实例操作） */
  domain?: string
  /** 页面里已经填过的 Worker 名 */
  workerName?: string
}

export interface EdgePickResult<T> {
  instance: T | null
  /** 是否「多个实例里随便挑了一个」——界面要提示用户确认 */
  ambiguous: boolean
}

/**
 * 从检测结果里挑要回填的实例。
 *
 * 优先级（与「部署页 / 凭据页」的既有习惯一致：用户当前输入即意图）：
 *   1. 域名精确匹配（忽略大小写、忽略尾部点）；
 *   2. Worker 名精确匹配；
 *   3. 只有一个实例；
 *   4. 以上都不满足：取第一个，并标记 ambiguous（界面要给出选择器）。
 */
export function pickEdgeInstance<T extends EdgeInstancePickable>(
  instances: T[],
  hint: EdgePickHint = {}
): EdgePickResult<T> {
  if (instances.length === 0) return { instance: null, ambiguous: false }

  const wantDomain = (hint.domain || '').trim().toLowerCase().replace(/\.$/, '')
  if (wantDomain) {
    const hit = instances.find((i) => (i.domain || '').trim().toLowerCase().replace(/\.$/, '') === wantDomain)
    if (hit) return { instance: hit, ambiguous: false }
  }

  const wantWorker = (hint.workerName || '').trim()
  if (wantWorker) {
    const hit = instances.find((i) => i.workerName === wantWorker)
    if (hit) return { instance: hit, ambiguous: false }
  }

  if (instances.length === 1) return { instance: instances[0]!, ambiguous: false }
  return { instance: instances[0]!, ambiguous: true }
}

/** 实例下拉项文案：Worker 名 + 域名（域名缺失时标注）。 */
export function edgeInstanceLabel(inst: EdgeInstancePickable): string {
  const domain = (inst.domain || '').trim()
  return domain ? `${inst.workerName} · ${domain}` : `${inst.workerName} · 未绑定域名`
}
