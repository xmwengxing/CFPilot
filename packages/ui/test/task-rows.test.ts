import { describe, expect, it } from 'vitest'
import { scanParamsSummary, taskRowHtml } from '../src/task-rows'

/**
 * 定时任务清单的**行渲染**回归测试。
 *
 * 钉住两条最容易回退的规则：
 *
 * 1. **内置任务没有勾选框**。
 *    给了勾选框，用户就会去点「删除所选」，而内置任务删不掉
 *    （服务端会跳过）—— 点了却没删成，很割裂。内置任务只需要能编辑。
 *
 * 2. **气泡只显示优选参数**，不显示说明。
 *    说明不是重要信息，点「编辑」就能看到；
 *    塞进气泡反而把参数挤到看不清。
 */

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task_1',
    name: '测试任务',
    description: '这是一条说明文字',
    builtin: false,
    profileId: 'acc_1',
    enabled: false,
    intervalDays: 2,
    runAt: '01:00',
    minSpeedMBps: 0,
    scan: {
      family: 'both',
      countries: [],
      sample: 1500,
      top: 8,
      speedMode: 'two',
      speedDurationMs: 6000,
      speedConnections: 8,
      probeTransport: 'ws',
    },
    anchorAt: 0,
    ...over,
  } as ScheduledTask
}

describe('任务行渲染', () => {
  it('内置任务没有勾选框', () => {
    const html = taskRowHtml(task({ builtin: true }), false)
    expect(html).not.toContain('type="checkbox"')
    // 那一列留一个占位符，避免看起来像渲染坏了
    expect(html).toContain('—')
  })

  it('内置任务即便传入 checked 也不给勾选框', () => {
    const html = taskRowHtml(task({ builtin: true }), true)
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('checked')
  })

  it('普通任务有勾选框，并带上 task id', () => {
    const html = taskRowHtml(task({ id: 'task_abc' }), true)
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('data-task-id="task_abc"')
    expect(html).toContain('checked')
  })

  it('气泡只显示优选参数，不显示说明', () => {
    const html = taskRowHtml(task({ description: '这是一条说明文字' }), false)
    expect(html).toContain('优选参数：')
    // 说明**不出现**在气泡里
    expect(html).not.toContain('这是一条说明文字')
    expect(html).not.toContain('说明：')
  })

  it('末列是「编辑」按钮，且带 task id', () => {
    const html = taskRowHtml(task({ id: 'task_xyz' }), false)
    expect(html).toContain('data-task-edit="task_xyz"')
    expect(html).toContain('>编辑</button>')
    // 编辑按钮在最后一格
    const cells = html.split('<td').length - 1
    expect(cells).toBe(11)
    expect(html.lastIndexOf('data-task-edit')).toBeGreaterThan(html.lastIndexOf('data-task-toggle'))
  })

  it('启用 / 停用按钮都在', () => {
    const off = taskRowHtml(task({ enabled: false }), false)
    expect(off).toContain('>启用</button>')
    const on = taskRowHtml(task({ enabled: true }), false)
    expect(on).toContain('>停用</button>')
  })

  it('说明不出现在表格任何一格（只在编辑弹窗里）', () => {
    const html = taskRowHtml(task({ description: '秘密说明XYZ' }), false)
    expect(html).not.toContain('秘密说明XYZ')
  })
})

describe('优选参数摘要', () => {
  it('含地址族、地区、采样与保留数', () => {
    const s = scanParamsSummary({
      family: 'v4',
      countries: ['ASIA'],
      sample: 1500,
      top: 8,
      speedMode: 'two',
    } as ScheduledScanParams)
    expect(s).toContain('IPv4')
    expect(s).toContain('ASIA')
    expect(s).toContain('1500')
    expect(s).toContain('8')
  })

  it('空参数不崩', () => {
    expect(scanParamsSummary(undefined as unknown as ScheduledScanParams)).toBe('—')
  })
})
