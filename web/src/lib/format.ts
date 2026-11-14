const YOCTO = 10n ** 24n
const WEI = 10n ** 18n

function fixed(v: bigint, unit: bigint, dp: number): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const whole = a / unit
  const frac = a % unit
  const scale = 10n ** BigInt(dp)
  let f = (frac * scale + unit / 2n) / unit
  let w = whole
  if (f >= scale) { w += 1n; f -= scale }
  const fs = dp > 0 ? '.' + f.toString().padStart(dp, '0').replace(/0+$/, '') : ''
  return (neg ? '-' : '') + w.toString() + (fs === '.' ? '' : fs)
}

/** 1234500000000000000000000 -> "1.2345" (max 4 dp, trailing zeros trimmed) */
export function near(yocto: string | bigint, dp = 4): string {
  try { return fixed(BigInt(yocto), YOCTO, dp) } catch { return '0' }
}

export function toYocto(nearAmount: string): string {
  const [w, f = ''] = nearAmount.trim().split('.')
  return (BigInt(w || '0') * YOCTO + BigInt((f + '0'.repeat(24)).slice(0, 24))).toString()
}

export function eth(wei: string | bigint, dp = 4): string {
  try { return fixed(BigInt(wei), WEI, dp) } catch { return '0' }
}

/** The game's own NPC accounts, shown by persona (web/functions/_lib/houseNpcs.ts holds the house NPCs' bios). */
const PERSONAS: Record<string, string> = {
  'vance.titleshot.testnet': 'Velvet Vance',
  'house-a.titleshot.testnet': 'Mother Ruckus',
  'house-b.titleshot.testnet': 'Professor Quill',
}
/** "1 defence", "3 defences". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const personaOf = (id: string): string | null => PERSONAS[id] ?? null

export function shortAccount(id: string): string {
  const persona = PERSONAS[id]
  if (persona) return persona
  if (id.length <= 22) return id
  if (/^[0-9a-f]{64}$/.test(id)) return id.slice(0, 6) + '…' + id.slice(-4)
  const parts = id.split('.')
  const head = parts[0]
  return (head.length > 14 ? head.slice(0, 12) + '…' : head) + '.' + parts.slice(1).join('.')
}

export function shortHex(h: string, n = 4): string {
  const s = h.startsWith('0x') ? h.slice(2) : h
  return (h.startsWith('0x') ? '0x' : '') + s.slice(0, n) + '…' + s.slice(-n)
}

/** "2h 14m", "14m 03s", "42s" */
export function countdown(ms: number): string {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}
