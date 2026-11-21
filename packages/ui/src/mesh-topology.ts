/**
 * 异地组网拓扑动画引擎（从 MobiHop 原型 docs/mobihop原型设计.html 移植）。
 *
 * 原生 Canvas 2D + requestAnimationFrame，零第三方依赖（对齐 packages/ui 零依赖约束）。
 * 移植自 MobiHop 的 vanilla Canvas 引擎（原型 L1241-1579），保留核心：
 *   - 本机居中、远端按双环布局（归一化坐标 fx/fy，无 fx 时按索引铺环）
 *   - 连线（每个远端直连本机）+ 节点呼吸 + 流量粒子脉冲
 *   - 空闲 12fps / 有脉冲 60fps、页面隐藏即停（省资源）
 *   - DPR 高清适配
 *
 * 2026-11-20 增强（用户反馈「没组网时拓扑一片空白」）：
 *   - 没有对端时不再只画一个孤点，而是画「雷达扫描」待机场景
 *     （虚线环 + 扫描扇形 + 环绕粒子 + 扩散 ping）；
 *   - 三态：offline（未启动，灰蓝）/ waiting（已启动无对端，蓝色扩散）/ active（有对端）；
 *   - 跟随 data-theme 自动切换深 / 浅色调色板（修掉浅色主题下发白的标签）；
 *   - 尊重 prefers-reduced-motion（静态帧，不旋转）。
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
  /** 打洞阶段与类型，连线旁显示呼吸提示 */
  punchState?: string
  punchKind?: string
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

export interface TopoStateOptions {
  /** 组网服务是否在运行（决定空态的画法与配色） */
  running?: boolean
  /**
   * 是否允许引擎自行启动动画（默认 true）。
   *
   * 组网页不可见时 renderer 传 false：轮询仍会 setData，
   * 但没必要为一个 display:none 的画布跑 rAF。
   */
  autoStart?: boolean
}

/** 拓扑展示态：未启动 / 已启动等对端 / 有对端 */
export type TopoPhase = 'offline' | 'waiting' | 'active'

/**
 * 按「是否运行 + 对端数量」判定展示态。
 *
 * 抽成纯函数：renderer 与浮层文案都依赖它，单测可直接覆盖三条分支。
 */
export function resolveTopoPhase(running: boolean, peerCount: number): TopoPhase {
  if (peerCount > 0) return 'active'
  return running ? 'waiting' : 'offline'
}

interface RenderNode extends TopoNode {
  px: number
  py: number
}

interface Palette {
  self: string
  p2p: string
  relay: string
  off: string
  text: string
  muted: string
  /** 空态主色（雷达 / 环 / 粒子） */
  accent: string
  accentRgb: string
  ring: string
  sweep: number
}

function palette(light: boolean): Palette {
  return light
    ? {
        self: '#0284c7',
        p2p: '#16a34a',
        relay: '#d97706',
        off: '#94a3b8',
        text: '#0f172a',
        muted: '#64748b',
        accent: '#0284c7',
        accentRgb: '2, 132, 199',
        ring: 'rgba(2, 132, 199, 0.22)',
        sweep: 0.10,
      }
    : {
        self: '#38bdf8',
        p2p: '#22c55e',
        relay: '#f59e0b',
        off: '#475569',
        text: '#e2e8f0',
        muted: '#94a3b8',
        accent: '#38bdf8',
        accentRgb: '56, 189, 248',
        ring: 'rgba(56, 189, 248, 0.20)',
        sweep: 0.16,
      }
}

export class MeshTopology {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private nodes: TopoNode[] = []
  private pulses: TopoPulse[] = []
  private phase: TopoPhase = 'offline'
  private animRunning = false
  private lastDraw = 0
  private ro: ResizeObserver | null = null
  private onVisibility: () => void
  private themeObserver: MutationObserver | null = null
  private light = false
  private reduced = false
  private mediaReduced: MediaQueryList | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D 不可用')
    this.ctx = ctx
    this.light = document.documentElement.getAttribute('data-theme') === 'light'
    this.reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.onVisibility = () => {
      if (document.hidden) this.stop()
      else if (this.nodes.length > 0) this.start()
    }
    document.addEventListener('visibilitychange', this.onVisibility)

    // 主题切换（html[data-theme]）时换调色板：深色下硬编码的浅色文字在浅色主题会发白。
    if (typeof MutationObserver !== 'undefined') {
      this.themeObserver = new MutationObserver(() => {
        const next = document.documentElement.getAttribute('data-theme') === 'light'
        if (next !== this.light) {
          this.light = next
          this.draw(performance.now())
        }
      })
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }
    if (typeof window.matchMedia === 'function') {
      this.mediaReduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      const onChange = (): void => {
        this.reduced = this.mediaReduced?.matches ?? false
      }
      if (typeof this.mediaReduced.addEventListener === 'function') {
        this.mediaReduced.addEventListener('change', onChange)
      }
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize())
      this.ro.observe(canvas)
    }
    this.resize()
  }

  /** 更新拓扑数据（节点 / 脉冲 / 运行态），引擎自动重绘。 */
  setData(nodes: TopoNode[], pulses: TopoPulse[] = [], options: TopoStateOptions = {}): void {
    this.nodes = nodes
    this.pulses = pulses.slice(-120)
    const peers = this.nodes.filter((n) => n.connType !== 'self').length
    const running = options.running ?? peers > 0
    this.phase = resolveTopoPhase(running, peers)
    // 有数据且允许时确保运行（不可见页面由调用方传 autoStart:false）
    if (options.autoStart !== false && !document.hidden && this.nodes.length > 0 && !this.animRunning) {
      this.start()
    }
  }

  /** 当前展示态（浮层文案与它保持一致）。 */
  currentPhase(): TopoPhase {
    return this.phase
  }

  start(): void {
    if (this.animRunning) return
    this.animRunning = true
    this.lastDraw = 0
    this.loop()
  }

  stop(): void {
    this.animRunning = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private raf = 0

  destroy(): void {
    this.stop()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.ro?.disconnect()
    this.themeObserver?.disconnect()
  }

  /** 页签切回时重算尺寸（隐藏页 getBoundingClientRect 为 0）。 */
  refresh(): void {
    this.resize()
  }

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

  private frameInterval(): number {
    if (this.reduced) return 500
    if (this.pulses.length > 0 || this.nodes.some((n) => n.punchState === 'probing' || n.punchState === 'retrying')) return 16
    if (this.phase === 'active' || this.phase === 'waiting') return 33
    return 80
  }

  private loop(): void {
    if (!this.animRunning) return
    const now = performance.now()
    if (now - this.lastDraw >= this.frameInterval()) {
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
    const c = palette(this.light)
    ctx.clearRect(0, 0, w, h)

    const nodes = this.layout(w, h)
    const center = nodes.find((n) => n.connType === 'self')
    const cx = center?.px ?? w * 0.5
    const cy = center?.py ?? h * 0.52
    const byId = new Map(nodes.map((n) => [n.id, n]))

    if (this.phase !== 'active') {
      this.drawIdle(now, w, h, cx, cy, c, this.phase === 'waiting')
    }

    // 连线：每个非本机节点直连本机
    if (center) {
      for (const n of nodes) {
        if (n.connType === 'self') continue
        ctx.beginPath()
        ctx.moveTo(center.px, center.py)
        ctx.lineTo(n.px, n.py)
        // 连线按真实状态着色：绿=直连、琥珀=中继、暗=离线
        ctx.strokeStyle = !n.up
          ? this.light
            ? 'rgba(100,116,139,0.18)'
            : 'rgba(148,163,184,0.10)'
          : n.connType === 'relay'
            ? this.light
              ? 'rgba(217,119,6,0.55)'
              : 'rgba(245,158,11,0.55)'
            : this.light
              ? 'rgba(22,163,74,0.55)'
              : 'rgba(34,197,94,0.55)'
        ctx.lineWidth = 1.2
        ctx.stroke()
        const punching = n.punchState === 'probing' || n.punchState === 'retrying'
        if (punching) {
          const alpha = this.reduced ? 0.75 : 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now / 300))
          ctx.beginPath()
          ctx.moveTo(center.px, center.py)
          ctx.lineTo(n.px, n.py)
          ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`
          ctx.lineWidth = 3
          ctx.stroke()
          const t = 0.62
          const mx = center.px + (n.px - center.px) * t
          const my = center.py + (n.py - center.py) * t
          ctx.fillStyle = c.text
          ctx.font = '10px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(`打洞中·${n.punchKind || 'NAT'}`, mx, my - 8)
        }
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
        ctx.fillStyle = c.accent
        ctx.globalAlpha = 1 - t
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    // 节点
    for (const n of nodes) {
      const color = !n.up ? c.off : n.connType === 'self' ? c.self : n.connType === 'p2p' ? c.p2p : c.relay
      const baseR = n.connType === 'self' ? 13 : 9
      // 呼吸光晕
      const breath = n.up && !this.reduced ? 1 + 0.12 * Math.sin(now / 420 + n.id.length) : 1
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
      ctx.strokeStyle = this.light ? 'rgba(15,23,42,0.35)' : 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.stroke()

      // 标签
      ctx.fillStyle = c.text
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(n.label || n.id.slice(0, 8), n.px, n.py + baseR + 14)
      if (n.vip) {
        ctx.fillStyle = c.muted
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(n.vip, n.px, n.py + baseR + 27)
      }
      // RTT 与丢包率来自 UDP 探针；经 WSS 中继时不能代表中继链路质量。
      if (n.rttMs != null) {
        const loss = n.lossPct
        const extra = loss != null ? ` · UDP 丢 ${Math.round(loss)}%` : ''
        ctx.fillStyle = n.up
          ? this.light
            ? 'rgba(22,163,74,0.95)'
            : 'rgba(34,197,94,0.95)'
          : c.muted
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(`RTT ${Math.round(n.rttMs)}ms${extra}`, n.px, n.py + baseR + 40)
      }
    }
  }

  /**
   * 空态（未启动 / 等待对端）的雷达场景。
   *
   * 设计意图：没有对端时不是「没有数据」，而是「正在等待」——
   * 用缓慢旋转的虚线环 + 扫描扇形 + 环绕粒子把这件事表达出来。
   */
  private drawIdle(
    now: number,
    w: number,
    h: number,
    cx: number,
    cy: number,
    c: Palette,
    waiting: boolean
  ): void {
    const ctx = this.ctx
    const min = Math.min(w, h)
    const outer = Math.max(60, min * 0.36)
    const t = this.reduced ? 0.7 : now / 1000

    // 1) 同心虚线环（方向 / 速度不同，产生"活着"的感觉）
    const rings: Array<{ r: number; speed: number; dash: number[]; alpha: number }> = [
      { r: outer * 0.46, speed: 0.22, dash: [3, 6], alpha: 0.9 },
      { r: outer * 0.72, speed: -0.15, dash: [2, 9], alpha: 0.7 },
      { r: outer, speed: 0.09, dash: [1, 12], alpha: 0.5 },
    ]
    for (const ring of rings) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(t * ring.speed)
      ctx.beginPath()
      ctx.setLineDash(ring.dash)
      ctx.arc(0, 0, ring.r, 0, Math.PI * 2)
      ctx.strokeStyle = waiting ? c.ring : this.light ? 'rgba(100,116,139,0.28)' : 'rgba(148,163,184,0.20)'
      ctx.globalAlpha = ring.alpha
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // 2) 扫描扇形（只有运行中才有"在找对端"的语义）
    if (waiting) {
      const sweep = (Math.PI * 2) / 9
      const angle = t * 0.9
      const g = ctx.createRadialGradient(cx, cy, outer * 0.12, cx, cy, outer)
      g.addColorStop(0, `rgba(${c.accentRgb}, ${c.sweep})`)
      g.addColorStop(1, `rgba(${c.accentRgb}, 0)`)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, outer, angle, angle + sweep)
      ctx.closePath()
      ctx.fillStyle = g
      ctx.fill()
    }

    // 3) 扩散 ping（每 2 秒一轮，两圈错相位保证连续）
    if (waiting && !this.reduced) {
      for (const offset of [0, 0.5]) {
        const p = ((now / 2000 + offset) % 1 + 1) % 1
        const r = outer * (0.12 + p * 0.88)
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${c.accentRgb}, ${0.35 * (1 - p)})`
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
    }

    // 4) 环绕粒子：确定性相位，慢速公转
    const orbit = outer * 0.72
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + (this.reduced ? i * 0.4 : t * (0.18 + i * 0.012)) * (i % 2 === 0 ? 1 : -1)
      const px = cx + Math.cos(ang) * orbit
      const py = cy + Math.sin(ang) * orbit * 0.92
      ctx.beginPath()
      ctx.arc(px, py, 2, 0, Math.PI * 2)
      ctx.fillStyle = waiting ? c.accent : this.light ? 'rgba(100,116,139,0.55)' : 'rgba(148,163,184,0.45)'
      ctx.globalAlpha = waiting ? 0.7 : 0.45
      ctx.fill()
      ctx.globalAlpha = 1
    }

    // 5) 本机外圈的呼吸虚线（即使还没启动也有"这里就是本机"的锚点）
    ctx.beginPath()
    ctx.arc(cx, cy, 24, 0, Math.PI * 2)
    ctx.setLineDash([2, 5])
    ctx.strokeStyle = waiting ? `rgba(${c.accentRgb}, 0.5)` : this.light ? 'rgba(100,116,139,0.4)' : 'rgba(148,163,184,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
  }
}
