// KV layer of the spend ledger. Aggregates are integer nano-USD. Writes are deltas (read, add, write) so increments from
// other isolates survive; each key is written at most once per WRITE_GAP_MS by one isolate (KV allows ~1 write/s/key).
// A key whose write failed keeps its delta in memory for the next flush, and the ledger refuses new spend meanwhile.
import type { KVLike } from './env'
import type { PaidKind } from './pricing'

export type Who = 'public' | 'owner' | 'tick'
/** Spend in nano-USD: everything, the public share, the number of calls and a split by kind. */
export interface Agg { n: number; pub: number; calls: number; kinds: Partial<Record<PaidKind, number>> }
/** One recent-log record (docs/BUDGET.md): usd in USD, tokens as reported (0 when unknown). */
export interface Entry { ts: number; kind: PaidKind; model: string; in: number; out: number; usd: number; who: Who }
export interface Pending { total: Agg; days: Record<string, Agg>; log: Entry[] }

export const LOG_MAX = 50
const DAY_TTL_SEC = 40 * 86_400

export const totalKey = (fp: string) => `ledger:${fp}:total`
export const dayKey = (fp: string, day: string) => `ledger:${fp}:day:${day}`
export const logKey = (fp: string) => `ledger:${fp}:log`
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const nextMidnight = (ms: number): string => new Date((Math.floor(ms / 86_400_000) + 1) * 86_400_000).toISOString()

export const emptyAgg = (): Agg => ({ n: 0, pub: 0, calls: 0, kinds: {} })
export const emptyPending = (): Pending => ({ total: emptyAgg(), days: {}, log: [] })
export const isEmpty = (p: Pending): boolean => p.total.calls === 0 && p.total.n === 0 && !Object.keys(p.days).length && !p.log.length

export function addInto(a: Agg, b: Agg): Agg {
  a.n += b.n
  a.pub += b.pub
  a.calls += b.calls
  for (const [k, v] of Object.entries(b.kinds) as [PaidKind, number][]) a.kinds[k] = (a.kinds[k] ?? 0) + v
  return a
}

export function record(p: Pending, day: string, kind: PaidKind, n: number, pub: boolean, calls: number, entry: Entry | null): void {
  const d: Agg = { n, pub: pub ? n : 0, calls, kinds: { [kind]: n } }
  addInto(p.total, d)
  addInto((p.days[day] ??= emptyAgg()), d)
  if (entry) p.log.push(entry)
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : NaN)

/** Parse a stored aggregate. Missing = zero; anything unreadable throws (a corrupted ledger must not read as "nothing spent"). */
export function parseAgg(raw: string | null): Agg {
  if (raw === null) return emptyAgg()
  const j = JSON.parse(raw) as Partial<Agg>
  const a: Agg = { n: int(j.n), pub: int(j.pub), calls: int(j.calls), kinds: {} }
  if ([a.n, a.pub, a.calls].some(Number.isNaN)) throw new Error('corrupt ledger aggregate')
  for (const [k, v] of Object.entries(j.kinds ?? {})) if (!Number.isNaN(int(v))) a.kinds[k as PaidKind] = int(v)
  return a
}

/** The lifetime and today's aggregates. Throws when KV cannot be read: callers fail closed. */
export async function readAggs(kv: KVLike, fp: string, day: string): Promise<[Agg, Agg]> {
  const [t, d] = await Promise.all([kv.get(totalKey(fp)), kv.get(dayKey(fp, day))])
  return [parseAgg(t), parseAgg(d)]
}

async function addAgg(kv: KVLike, key: string, delta: Agg, ttl?: number): Promise<void> {
  const cur = parseAgg(await kv.get(key))
  await kv.put(key, JSON.stringify(addInto(cur, delta)), ttl ? { expirationTtl: ttl } : undefined)
}

async function appendLog(kv: KVLike, key: string, entries: Entry[]): Promise<void> {
  let cur: Entry[] = []
  try { const raw = await kv.get(key); cur = raw ? (JSON.parse(raw) as Entry[]) : [] } catch { cur = [] }
  await kv.put(key, JSON.stringify([...(Array.isArray(cur) ? cur : []), ...entries].slice(-LOG_MAX)))
}

/**
 * Write `delta` and return what could NOT be written (empty when all went through). The recent log is a convenience: a
 * failed log write is dropped, never retried, since it cannot cause under-counting.
 */
export async function writeDelta(kv: KVLike, fp: string, delta: Pending): Promise<Pending> {
  const failed = emptyPending()
  if (delta.total.calls || delta.total.n) {
    try { await addAgg(kv, totalKey(fp), delta.total) } catch { failed.total = delta.total }
  }
  for (const [day, agg] of Object.entries(delta.days)) {
    try { await addAgg(kv, dayKey(fp, day), agg, DAY_TTL_SEC) } catch { failed.days[day] = agg }
  }
  if (delta.log.length) await appendLog(kv, logKey(fp), delta.log).catch(() => undefined)
  return failed
}

export function mergePending(into: Pending, from: Pending): void {
  addInto(into.total, from.total)
  for (const [day, agg] of Object.entries(from.days)) addInto((into.days[day] ??= emptyAgg()), agg)
  into.log.push(...from.log)
}
