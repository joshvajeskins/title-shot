// KV-backed fixed-window counters, built around two Workers KV facts: one key accepts about one write per second, and a
// read-then-write is not atomic. So the count lives in isolate memory (exact for everything that lands on this isolate,
// via the per-key lane in lane.ts) and is flushed to KV at most once per WRITE_GAP_MS per key; a cold isolate starts from
// the last flushed count. Across isolates the limit is best-effort (a burst can overshoot by what one isolate did within a
// second); money paths add their own floors and the global daily caps below.
// A KV failure is never a 500: paid endpoints fail closed (429 RATE_LIMITED), /api/state fails open.
import type { KVLike } from './env'
import { ApiError, clientIp } from './http'
import { serialize } from './lane'

export interface Rule { name: string; limit: number; windowSec: number }

export const RULES = {
  guestIp: { name: 'guest-ip', limit: 3, windowSec: 86_400 },
  guestGlobal: { name: 'guest-all', limit: 150, windowSec: 86_400 },
  previewMin: { name: 'preview-min', limit: 12, windowSec: 60 },
  previewDay: { name: 'preview-day', limit: 300, windowSec: 86_400 },
  portraitGen: { name: 'portrait-gen', limit: 6, windowSec: 60 },
  cryGen: { name: 'cry-gen', limit: 6, windowSec: 60 },
  stateMin: { name: 'state-min', limit: 600, windowSec: 60 },
} as const satisfies Record<string, Rule>

/** Global spend caps (all callers together, per UTC day). Over the cap: 429 DAILY_CAP. */
export const CAPS = {
  previewCompile: { name: 'cap-preview', limit: 600, windowSec: 86_400 },
  portraitGen: { name: 'cap-portrait', limit: 200, windowSec: 86_400 },
  cryGen: { name: 'cap-cry', limit: 300, windowSec: 86_400 },
} as const satisfies Record<string, Rule>

export const WRITE_GAP_MS = 1_100

export interface LimitResult { ok: boolean; count: number; limit: number; retryAfter: number }

/** The counter store could not be read or written. Callers decide whether that means "refuse" or "let through". */
export class KvUnavailable extends Error {}

interface Entry { count: number; flushedAt: number; expSec: number }
const memory = new Map<string, Entry>()
const MEMORY_MAX = 4_000

/** Forget every in-isolate counter (tests; a cold isolate does the same). */
export function resetRateMemory(): void { memory.clear() }

function prune(nowSec: number): void {
  if (memory.size < MEMORY_MAX) return
  for (const [k, v] of memory) if (v.expSec < nowSec) memory.delete(k)
  if (memory.size >= MEMORY_MAX) memory.clear() // pathological: start over rather than grow without bound
}

/** Increment and check. Pure apart from the stores: `now` is injected for tests. Throws KvUnavailable when KV fails. */
export function consume(kv: KVLike, rule: Rule, id: string, now = Date.now()): Promise<LimitResult> {
  const nowSec = Math.floor(now / 1000)
  const bucket = Math.floor(nowSec / rule.windowSec)
  const key = `rl:${rule.name}:${id}:${bucket}`
  const retryAfter = Math.max(1, (bucket + 1) * rule.windowSec - nowSec)
  return serialize(key, async () => {
    let e = memory.get(key)
    if (!e) {
      let stored = 0
      try { stored = Number((await kv.get(key)) ?? '0') || 0 } catch { throw new KvUnavailable('kv read failed') }
      prune(nowSec)
      e = { count: stored, flushedAt: 0, expSec: (bucket + 1) * rule.windowSec }
      memory.set(key, e)
    }
    const count = e.count + 1
    if (count > rule.limit) return { ok: false, count, limit: rule.limit, retryAfter }
    if (now - e.flushedAt >= WRITE_GAP_MS || now < e.flushedAt) {
      try { await kv.put(key, String(count), { expirationTtl: Math.max(60, rule.windowSec + 60) }) } catch { throw new KvUnavailable('kv write failed') }
      e.flushedAt = now
    }
    e.count = count
    return { ok: true, count, limit: rule.limit, retryAfter }
  })
}

export type KvFailMode = 'closed' | 'open'

/** Throw 429 when over the limit. `failMode` says what a broken counter store means: refuse (paid endpoints) or allow (/api/state). */
export async function enforce(kv: KVLike, rule: Rule, request: Request, idOverride?: string, failMode: KvFailMode = 'closed'): Promise<void> {
  try {
    const r = await consume(kv, rule, idOverride ?? clientIp(request))
    if (!r.ok) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Slow down and try again shortly.', r.retryAfter)
  } catch (e) {
    if (!(e instanceof KvUnavailable)) throw e
    if (failMode === 'open') return
    throw new ApiError(429, 'RATE_LIMITED', 'Busy right now. Try again in a few seconds.', 3)
  }
}

/** Spend one unit of a global daily cap. Over the cap: 429 DAILY_CAP. A broken counter store refuses (spend must not be unmetered). */
export async function spendCap(kv: KVLike, cap: Rule, now = Date.now()): Promise<void> {
  try {
    const r = await consume(kv, cap, 'all', now)
    if (!r.ok) throw new ApiError(429, 'DAILY_CAP', 'Today\'s free capacity for this is used up. It resets at midnight UTC; fighters already forged still work.', r.retryAfter)
  } catch (e) {
    if (!(e instanceof KvUnavailable)) throw e
    throw new ApiError(429, 'RATE_LIMITED', 'Busy right now. Try again in a few seconds.', 3)
  }
}
