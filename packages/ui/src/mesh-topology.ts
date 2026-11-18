/**
 * 异地组网拓扑动画引擎（从 MobiHop 原型 docs/mobihop原型设计.html 移植）。
 *
 * 原生 Canvas 2D + requestAnimationFrame，零第三方依赖（对齐 packages/ui 零依赖约束）。
 * 移植自 MobiHop 的 vanilla Canvas 引擎（原型 L1241-1579），保留核心：
 *   - 本机居中、远端按双环布局（归一化坐标 fx/fy，无 fx 时按索引铺环）
 *   - 连线（每个远端直连本机）+ 节点呼吸 + 流量粒子脉冲
 *   - 空闲 12fps / 有脉冲 60fps、页面隐藏即停（省资源）
 *   - DPR 高清适配
 */

export interface TopoNode {
  id: string
  label: string
  vip?: string
  connType: 'self' | 'p2p' | 'relay'
  up: boolean
  rttMs?: number | null
  /** 丢包百分比（0-100），有样本时才显示 */
  lossPct?: number | null
  txBps?: number
  rxBps?: number
  fx?: number // 归一化 x（0-1），仅手动布局用
  fy?: number // 归一化 y（0-1）
}

export interface TopoPulse {
  id: string
  to: string // 目标节点 id
  kind: 'traffic' | 'agent'
  bornAt: number
}

interface RenderNode extends TopoNode {
  px: number
  py: number
}

const COLOR = {
  self: '#38bdf8',
  p2p: '#22c55e',
  relay: '#f59e0b',
  off: '#475569',
  line: 'rgba(148,163,184,0.25)',
  pulse: '#38bdf8',
  text: '#e2e8f0',
}

export class MeshTopology {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private nodes: TopoNode[] = []
  private pulses: TopoPulse[] = []
  private raf = 0
  private running = false
  private lastDraw = 0
  private ro: ResizeObserver | null = null
  private onVisibility: () => void

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D 不可用')
    this.ctx = ctx
    this.onVisibility = () => {
      if (document.hidden) this.stop()
      else if (this.running) this.start()
    }
    document.addEventListener('visibilitychange', this.onVisibility)
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize())
      this.ro.observe(canvas)
    }
    this.resize()
  }

  /** 更新拓扑数据（节点 / 脉冲），引擎自动重绘。 */
  setData(nodes: TopoNode[], pulses: TopoPulse[] = []): void {
    this.nodes = nodes
    this.pulses = pulses.slice(-120)
    // 有数据时确保运行
    if (this.nodes.length > 0 && !this.running) this.start()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loop()
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  destroy(): void {
    this.stop()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.ro?.disconnect()
  }

  /** 页签切回时重算尺寸（隐藏页 getBoundingClientRect 为 0）。 */
  refresh(): void { this.resize() }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** 计算节点像素坐标：本机中心、远端双环铺开。 */
  private layout(w: number, h: number): RenderNode[] {
    const self = this.nodes.find((n) => n.connType === 'self')
    const remotes = this.nodes.filter((n) => n.connType !== 'self')
    const cx = w * 0.5
    const cy = h * 0.52
    const out: RenderNode[] = []

    if (self) {
      const fx = self.fx ?? 0.5
      const fy = self.fy ?? 0.52
      out.push({ ...self, px: fx * w, py: fy * h })
    }
    remotes.forEach((n, i) => {
      let px: number
      let py: number
      if (n.fx !== undefined && n.fy !== undefined) {
        px = n.fx * w
        py = n.fy * h
      } else {
        const angle = (i / Math.max(1, remotes.length)) * Math.PI * 2 - Math.PI / 2
        const radiusRatio = i % 2 === 0 ? 0.34 : 0.42
        px = cx + Math.cos(angle) * Math.min(w, h) * radiusRatio
        py = cy + Math.sin(angle) * Math.min(w, h) * radiusRatio * 0.82
      }
      out.push({ ...n, px, py })
    })
    return out
  }

  private loop(): void {
    if (!this.running) return
    const now = performance.now()
    // 有活跃脉冲时 60fps，否则 12fps（省资源）
    const active = this.pulses.length > 0
    const interval = active ? 16 : 83
    if (now - this.lastDraw >= interval) {
      this.draw(now)
      this.lastDraw = now
    }
    this.raf = requestAnimationFrame(() => this.loop())
  }

  private draw(now: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (w === 0 || h === 0) return
    const ctx = this.ctx
    ctx.clearRect(0, 0, w, h)

    const nodes = this.layout(w, h)
    const center = nodes.find((n) => n.connType === 'self')
    const byId = new Map(nodes.map((n) => [n.id, n]))

    // 连线：每个非本机节点直连本机
    if (center) {
      for (const n of nodes) {
        if (n.connType === 'self') continue
        ctx.beginPath()
        ctx.moveTo(center.px, center.py)
        ctx.lineTo(n.px, n.py)
        // 连线按真实状态着色：绿=直连、琥珀=中继、暗=离线
        ctx.strokeStyle = !n.up
          ? 'rgba(148,163,184,0.10)'
          : n.connType === 'relay'
            ? 'rgba(245,158,11,0.55)'
            : 'rgba(34,197,94,0.55)'
        ctx.lineWidth = 1.2
        ctx.stroke()
      }
    }

    // 脉冲粒子：沿本机→目标的连线移动
    const PULSE_LIFE = 1100
    this.pulses = this.pulses.filter((p) => now - p.bornAt < PULSE_LIFE)
    if (center) {
      for (const p of this.pulses) {
        const target = byId.get(p.to)
        if (!target) continue
        const t = (now - p.bornAt) / PULSE_LIFE
        const x = center.px + (target.px - center.px) * t
        const y = center.py + (target.py - center.py) * t
        ctx.beginPath()
        ctx.arc(x, y, p.kind === 'agent' ? 4 : 3, 0, Math.PI * 2)
        ctx.fillStyle = COLOR.pulse
        ctx.globalAlpha = 1 - t
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    // 节点
    for (const n of nodes) {
      const color = !n.up ? COLOR.off : n.connType === 'self' ? COLOR.self : n.connType === 'p2p' ? COLOR.p2p : COLOR.relay
      const baseR = n.connType === 'self' ? 13 : 9
      // 呼吸光晕
      const breath = n.up ? 1 + 0.12 * Math.sin(now / 420 + n.id.length) : 1
      ctx.beginPath()
      ctx.arc(n.px, n.py, (baseR + 6) * breath, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = 0.12
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.beginPath()
      ctx.arc(n.px, n.py, baseR, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.stroke()

      // 标签
      ctx.fillStyle = COLOR.text
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(n.label || n.id.slice(0, 8), n.px, n.py + baseR + 14)
      if (n.vip) {
        ctx.fillStyle = 'rgba(148,163,184,0.9)'
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(n.vip, n.px, n.py + baseR + 27)
      }
      // 真实测量值直接画在节点下方：一眼看出「连通但很慢 / 丢包严重」
      if (n.rttMs != null) {
        const loss = n.lossPct
        const extra = loss != null ? ` · 丢 ${Math.round(loss)}%` : ''
        ctx.fillStyle = n.up ? 'rgba(34,197,94,0.95)' : 'rgba(148,163,184,0.9)'
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(`RTT ${Math.round(n.rttMs)}ms${extra}`, n.px, n.py + baseR + 40)
      }
    }
  }
}

