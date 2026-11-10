/**
 * 定时优选任务清单的**行渲染**。
 *
 * ## 为什么单独成模块
 *
 * 表格行是纯数据 → HTML 的映射，没有副作用 —— 抽出来就能直接单测，
 * 不必起浏览器。而这两条恰恰是最容易回退的规则：
 *
 * 1. **内置任务没有勾选框**。
 *    给了勾选框，用户就会去点「删除所选」，而内置任务删不掉
 *    （服务端会跳过）—— 点了却没删成，很割裂。内置任务只需要能编辑。
 *
 * 2. **气泡只显示优选参数**，不显示说明。
 *    说明不是重要信息，点「编辑」就能看到；
 *    塞进气泡反而把参数挤到看不清。
 *
 * ## 类型说明
 *
 * `ScheduledTask` / `ScheduledScanParams` 来自 `globals.d.ts` ——
 * 那是**全局声明**（无 export），所以这里是全局类型，不需要 import。
 */

/** HTML 转义（与渲染器里的同名工具保持一致）。 */
export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 优选参数的一行摘要（气泡与弹窗共用）。 */
export function scanParamsSummary(p: ScheduledScanParams): string {
  if (!p) return '—'
  const family =
    p.family === 'v4'
      ? 'IPv4'
      : p.family === 'v6'
        ? 'IPv6'
        : p.family === 'both'
          ? 'IPv4+IPv6'
          : '自动'
  const countries = (p.countries || []).length ? p.countries.join(' / ') : '全部'
  const speed = p.speedMode === 'off' ? '不测速' : p.speedMode === 'one' ? '仅精测' : '两轮测速'
  return `${family} · ${countries} · 采样 ${p.sample} · 保留 ${p.top} · ${speed}`
}

/** 任务状态的可读文案。 */
export function taskStatusText(t: ScheduledTask): string {
  if (!t.enabled) return '已禁用'
  switch (t.lastStatus) {
    case 'ok':
      return `完成（${t.lastCount ?? 0} 条）`
    case 'relaxed':
      return `完成（筛选放宽 · ${t.lastCount ?? 0} 条）`
    case 'failed':
      return '失败：' + (t.lastMessage || '未知原因')
    case 'skipped':
      return '已跳过：' + (t.lastMessage || '')
    default:
      return '等待首次运行'
  }
}

/** 毫秒时间戳 → 可读时间。 */
export function formatTaskTime(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 渲染一行任务。
 *
 * @param t 任务
 * @param checked 是否被勾选（内置任务永远为 false）
 */
export function taskRowHtml(t: ScheduledTask, checked: boolean): string {
  const badge = t.builtin ? ' <span class="badge info">内置</span>' : ''
  const speed = t.minSpeedMBps > 0 ? `≥ ${t.minSpeedMBps} MB/s` : '不过滤'
  const next = t.enabled ? '运行中…' : '—'
  // 数据面域名是**运行期**从该账号的部署清单取的 —— 第一次跑完才有值。
  const host = t.lastHost || '（跑完一次后显示）'
  const toggle = t.enabled
    ? '<button class="btn btn-ghost btn-sm" data-task-toggle="' +
      escapeHtml(t.id) +
      '" title="停用后不再自动运行。">停用</button>'
    : '<button class="btn btn-ghost btn-sm" data-task-toggle="' +
      escapeHtml(t.id) +
      '" title="启用后到点自动运行优选。">启用</button>'
  // 气泡**只放优选参数**：说明不是重要信息，点「编辑」就能看到。
  const tip = '优选参数：' + scanParamsSummary(t.scan)
  const edit =
    '<button class="btn btn-ghost btn-sm" data-task-edit="' +
    escapeHtml(t.id) +
    '" title="编辑这条任务的名称、说明、周期、运行时间与速度过滤。">编辑</button>'
  // 内置任务不给勾选框（见文件头说明）。
  const checkCell = t.builtin
    ? '<span class="muted">—</span>'
    : `<input type="checkbox" data-task-id="${escapeHtml(t.id)}"${checked ? ' checked' : ''} />`
  return (
    '<tr>' +
    `<td>${checkCell}</td>` +
    `<td>${toggle}</td>` +
    `<td title="${escapeHtml(tip)}">${escapeHtml(t.name)}${badge}</td>` +
    `<td>${t.intervalDays} 天</td>` +
    `<td class="mono">${escapeHtml(t.runAt)}</td>` +
    `<td>${escapeHtml(speed)}</td>` +
    `<td class="muted">${escapeHtml(next)}</td>` +
    `<td class="muted">${escapeHtml(formatTaskTime(t.lastRunAt))}</td>` +
    `<td class="muted">${escapeHtml(taskStatusText(t))}</td>` +
    `<td class="muted mono" style="font-size:12px">${escapeHtml(host)}</td>` +
    `<td>${edit}</td>` +
    '</tr>'
  )
}
