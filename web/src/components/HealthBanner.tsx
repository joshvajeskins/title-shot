// The runway banner (lobby and belt pages): one calm line per thing the tick found below a day of use. Shows nothing when
// everything is funded, when the record is stale or when /api/state is unreachable (the page's own error state covers that).
import { useEffect, useState } from 'react'
import { useGame } from '../game/context'
import { healthLines, type Health, type HealthLine } from '../game/health'
import { Icon } from './Icon'
import './health.css'

let memo: { at: number; p: Promise<Health | null> } | null = null
/** /api/state's health record, shared by every banner on the page for 30 s. */
function loadHealth(): Promise<Health | null> {
  if (memo && Date.now() - memo.at < 30_000) return memo.p
  const p = fetch('/api/state').then((r) => (r.ok ? r.json() : null)).then((s: { health?: Health | null } | null) => s?.health ?? null).catch(() => null)
  memo = { at: Date.now(), p }
  return p
}

/** Development builds only (stripped from production): ?health=out or ?health=house:out,sponsor:low forces the banner. */
function devForce(h: Health | null): Health | null {
  if (!import.meta.env.DEV) return h
  const q = new URLSearchParams(location.search).get('health')
  if (!q) return h
  const base: Health = h ?? { at: Date.now(), checks: [], forgeResetsAt: null }
  const all = ['promoter_eth', 'promoter_near', 'house', 'sponsor', 'forge'] as const
  const want = new Map(q.split(',').map((x) => x.split(':')).map(([k, l]) => (l ? [k, l] : ['*', k]) as [string, string]))
  const lvl = (k: string) => (want.get(k) ?? want.get('*') ?? 'ok') as 'ok' | 'low' | 'out'
  return { ...base, at: Date.now(), forgeResetsAt: base.forgeResetsAt ?? new Date(Date.now() + 3 * 3600_000).toISOString(), checks: all.map((key) => ({ key, level: lvl(key), have: 0, dayNeed: 0, floor: 0, unit: 'NEAR' })) }
}

const resetAt = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
}

export function HealthBanner() {
  const { client } = useGame()
  const [lines, setLines] = useState<HealthLine[]>([])
  const [reset, setReset] = useState<string | null>(null)
  useEffect(() => {
    if (client.mode !== 'testnet' && !import.meta.env.DEV) return
    let on = true
    loadHealth().then(devForce).then((h) => { if (!on) return; setLines(healthLines(h)); setReset(resetAt(h?.forgeResetsAt ?? null)) })
    return () => { on = false }
  }, [client])
  if (!lines.length) return null
  return (
    <aside className="health" role="status" aria-label="Game status">
      <Icon name="bell" size={16} />
      <ul>
        {lines.map((l) => (
          <li key={l.key} className={`health-${l.level}`}>
            {l.text}{l.key === 'forge' && l.level === 'out' && reset ? ` It reopens at ${reset}.` : ''}
          </li>
        ))}
      </ul>
    </aside>
  )
}
