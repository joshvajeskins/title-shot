// Canvas particle layer for impacts. Integer-free decoration only: never feeds back into game state.
import type { School } from '../game/types'

interface P { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; kind: 'dot' | 'spark' | 'ring' | 'slash' | 'leaf'; rot: number; vr: number }

const PALETTE: Record<School | 'INK', string[]> = {
  BLAZE: ['#E8402C', '#E9B949', '#ffcf6b', '#ff7a3a'],
  TIDE: ['#3D6BE0', '#9db8ff', '#F2E8D5', '#6fd0ff'],
  VOLT: ['#E9B949', '#fff3b0', '#9db8ff', '#ffffff'],
  IRON: ['#F2E8D5', '#b9ad98', '#8a8478', '#E9B949'],
  MIND: ['#c48bff', '#9db8ff', '#F2E8D5', '#ff8ad8'],
  WILD: ['#7fbf6a', '#E9B949', '#E8402C', '#F2E8D5'],
  INK: ['#0E0D12', '#E8402C', '#F2E8D5'],
}

export class Vfx {
  private ctx: CanvasRenderingContext2D
  private ps: P[] = []
  private raf = 0
  private dpr = Math.min(2, window.devicePixelRatio || 1)
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  private canvas: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    window.addEventListener('resize', this.resize)
  }
  resize = () => {
    const r = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
  }
  destroy() { cancelAnimationFrame(this.raf); window.removeEventListener('resize', this.resize); this.ps = [] }

  burst(x: number, y: number, school: School | 'INK', power = 1, dir = 1) {
    if (this.reduced) return
    const cols = PALETTE[school]
    const n = Math.round((school === 'INK' ? 14 : 26) * power)
    const kind: P['kind'] = school === 'VOLT' ? 'spark' : school === 'WILD' ? 'leaf' : 'dot'
    for (let i = 0; i < n; i++) {
      const a = (Math.random() - 0.5) * Math.PI * 1.4 + (dir > 0 ? 0 : Math.PI)
      const sp = (2 + Math.random() * 7) * power
      this.ps.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, life: 0, max: 26 + Math.random() * 26, size: 2 + Math.random() * 5 * power, color: cols[i % cols.length], kind, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4 })
    }
    if (school === 'MIND' || school === 'TIDE') for (let i = 0; i < 3; i++) this.ps.push({ x, y, vx: 0, vy: 0, life: -i * 5, max: 34, size: 10, color: cols[i], kind: 'ring', rot: 0, vr: 0 })
    if (school === 'WILD' || school === 'IRON') for (let i = 0; i < 3; i++) this.ps.push({ x: x + (i - 1) * 16, y, vx: 0, vy: 0, life: -i * 2, max: 16, size: 90 * power, color: i === 1 ? '#F2E8D5' : cols[0], kind: 'slash', rot: -0.9, vr: 0 })
    this.loop()
  }

  private loop() {
    if (this.raf) return
    const step = () => {
      const { ctx } = this
      const d = this.dpr
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      this.ps = this.ps.filter((p) => p.life < p.max)
      for (const p of this.ps) {
        p.life++
        if (p.life < 0) continue
        const t = p.life / p.max
        ctx.globalAlpha = Math.max(0, 1 - t)
        ctx.fillStyle = p.color
        ctx.strokeStyle = p.color
        if (p.kind === 'ring') {
          ctx.lineWidth = 3 * d
          ctx.beginPath(); ctx.arc(p.x * d, p.y * d, (p.size + t * 120) * d, 0, Math.PI * 2); ctx.stroke()
          continue
        }
        if (p.kind === 'slash') {
          const len = p.size * Math.min(1, t * 3)
          ctx.lineWidth = (7 - t * 6) * d
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo((p.x - Math.cos(p.rot) * len / 2) * d, (p.y - Math.sin(p.rot) * len / 2 - 30) * d)
          ctx.lineTo((p.x + Math.cos(p.rot) * len / 2) * d, (p.y + Math.sin(p.rot) * len / 2 - 30) * d)
          ctx.stroke()
          continue
        }
        p.x += p.vx; p.y += p.vy; p.vy += 0.32; p.vx *= 0.96; p.rot += p.vr
        if (p.kind === 'spark') {
          ctx.lineWidth = 2.2 * d
          ctx.beginPath(); ctx.moveTo(p.x * d, p.y * d); ctx.lineTo((p.x - p.vx * 3) * d, (p.y - p.vy * 3) * d); ctx.stroke()
        } else if (p.kind === 'leaf') {
          ctx.save(); ctx.translate(p.x * d, p.y * d); ctx.rotate(p.rot)
          ctx.beginPath(); ctx.ellipse(0, 0, p.size * d, p.size * 0.45 * d, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
        } else {
          ctx.beginPath(); ctx.arc(p.x * d, p.y * d, p.size * (1 - t * 0.6) * d, 0, Math.PI * 2); ctx.fill()
        }
      }
      ctx.globalAlpha = 1
      if (this.ps.length) this.raf = requestAnimationFrame(step)
      else { this.raf = 0; ctx.clearRect(0, 0, this.canvas.width, this.canvas.height) }
    }
    this.raf = requestAnimationFrame(step)
  }
}
