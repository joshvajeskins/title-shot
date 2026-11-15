// Runway health (written by the tick, served in /api/state as `health`): is each thing the game spends from funded for
// about a day of use? The lobby and belt pages turn every check that is not `ok` into one calm line, never a silent failure.

export type HealthLevel = 'ok' | 'low' | 'out' | 'unknown'
export type HealthKey = 'promoter_eth' | 'promoter_near' | 'house' | 'sponsor' | 'forge'

export interface HealthCheck {
  key: HealthKey
  /** ok: a day of use is covered; low: less than a day left, still working; out: the next action would fail; unknown: unreadable */
  level: HealthLevel
  /** what is held now and what one day of use needs, in `unit` (display only) */
  have: number
  dayNeed: number
  /** below this the next action fails */
  floor: number
  unit: 'NEAR' | 'ETH' | 'USD'
}

export interface Health { at: number; checks: HealthCheck[]; forgeResetsAt: string | null }

/** A record older than this is not trusted either way (the tick writes one every few minutes). */
export const HEALTH_MAX_AGE_MS = 60 * 60_000

const LINES: Record<HealthKey, { out: string; low: string }> = {
  promoter_eth: { out: 'Purse paused, refilling: season purses resume shortly.', low: 'The promoter’s purse money is running low and is being topped up. Seasons keep opening.' },
  promoter_near: { out: 'The next season is paused while the promoter refills: the belts on the card still fight.', low: 'The promoter is low on NEAR for opening seasons and is being topped up.' },
  house: { out: 'House fighters resting: idle belts wait for a challenger like you.', low: 'House fighters are low on fight money and may rest soon. Your challenges are unaffected.' },
  sponsor: { out: 'Judge demo accounts are refilling: connect a wallet to play now.', low: 'Judge demo accounts are running low and being refilled. A wallet always works.' },
  forge: { out: 'Today’s forge budget is spent: already-forged sentences still fight.', low: 'Today’s forge budget is nearly spent: already-forged sentences always fight.' },
}
const ORDER: HealthKey[] = ['forge', 'sponsor', 'promoter_eth', 'promoter_near', 'house']

export interface HealthLine { key: HealthKey; level: 'low' | 'out'; text: string }

/** The banner lines for a health record: every check below its runway, the ones that already stop something first. */
export function healthLines(h: Health | null | undefined, now = Date.now()): HealthLine[] {
  if (!h || !Array.isArray(h.checks) || now - h.at > HEALTH_MAX_AGE_MS) return []
  const lines = h.checks
    .filter((c): c is HealthCheck & { level: 'low' | 'out' } => c.level === 'low' || c.level === 'out')
    .map((c) => ({ key: c.key, level: c.level, text: LINES[c.key][c.level] }))
  return lines.sort((a, b) => (a.level === b.level ? ORDER.indexOf(a.key) - ORDER.indexOf(b.key) : a.level === 'out' ? -1 : 1))
}
