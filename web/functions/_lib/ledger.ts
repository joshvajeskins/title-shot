// The NEAR AI spend ledger (docs/BUDGET.md "Worker ledger"). One ledger per API key, keyed by its fingerprint (first 16 hex
// of sha256(key), never the key), so a rotated key starts from zero. Every paid call reserves its worst case first and is
// refused if the lifetime hard stop or (for public traffic) the public daily/total caps would be crossed; afterwards it
// settles to the real cost from the returned usage. Owner/test traffic (x-tick-secret) skips only the public caps.
// Exactness: reservations and unflushed spend are held per isolate and every check runs in one lane per key, so racing
// requests on one isolate cannot both pass; across isolates KV is the meeting point (best effort, like the rate limits).
// Any KV failure closes the ledger (fail closed) until a write goes through again.
import { sha256 } from '@noble/hashes/sha2.js'
import { toHex, utf8 } from '../../src/game/chain/bytes'
import type { Env, KVLike } from './env'
import { safeEqual } from './http'
import { serialize } from './lane'
import { emptyPending, isEmpty, mergePending, nextMidnight, readAggs, record, dayOf, writeDelta, type Agg, type Pending, type Who } from './ledgerStore'
import { loadPrices, peekPrices, priceOf, toNano, toUsd, usageNano, worstNano, type PaidKind, type Price, type Usage } from './pricing'

export type { Who } from './ledgerStore'
export type Reason = 'budget' | 'public_total' | 'public_daily' | 'ledger_unavailable' | 'no_key'
export const WRITE_GAP_MS = 1_100

export const fingerprint = (key: string): string => toHex(sha256(utf8(key))).slice(0, 16)

export interface Limits { budget: number; publicDaily: number; publicTotal: number } // nano-USD
const usdVar = (v: string | undefined, d: number): number => {
  const n = Number((v ?? '').trim())
  return toNano((v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d)
}
export const limitsOf = (env: Env): Limits => ({
  budget: usdVar(env.NEARAI_BUDGET_USD, 2.5), publicDaily: usdVar(env.NEARAI_PUBLIC_DAILY_USD, 0.05), publicTotal: usdVar(env.NEARAI_PUBLIC_TOTAL_USD, 0.25),
})

/** Owner/test traffic carries the tick secret; everything else is public. */
export const whoOf = (request: Request, env: Env): Who => {
  const given = request.headers.get('x-tick-secret')
  return given && env.TICK_SECRET && safeEqual(given, env.TICK_SECRET) ? 'owner' : 'public'
}

export class LedgerClosed extends Error {
  constructor(readonly reason: Reason, readonly resetsAt: string | null) { super(`ledger closed: ${reason}`) }
}

interface HoldRec { n: number; pub: boolean; day: string }
/** `inflight` = the delta being written right now: still counted, so a check during a flush never misses it. */
interface State { holds: Map<number, HoldRec>; pending: Pending; inflight: Pending | null; flushedAt: number; flushing: Promise<void> | null; scheduled: boolean; broken: boolean }
const states = new Map<string, State>()
let seq = 0
/** Forget every in-isolate ledger state (tests; a cold isolate does the same). */
export function resetLedgerMemory(): void { states.clear() }
const stateOf = (fp: string): State => {
  let s = states.get(fp)
  if (!s) { s = { holds: new Map(), pending: emptyPending(), inflight: null, flushedAt: 0, flushing: null, scheduled: false, broken: false }; states.set(fp, s) }
  return s
}

export interface Hold { id: number; kind: PaidKind; model: string; who: Who; price: Price; worst: number; day: string; done: boolean }
export interface LedgerDeps { fetchFn?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; defer?: (p: Promise<unknown>) => void }
export interface View { spent: number; pub: number; todayPub: number }
export interface Gate { open: boolean; reason: Reason | null; resetsAt: string | null }

export class Ledger {
  readonly fp: string
  private st: State
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  private defer: (p: Promise<unknown>) => void
  private fetchFn: typeof fetch
  constructor(readonly kv: KVLike, key: string, readonly limits: Limits, d: LedgerDeps = {}) {
    this.fp = fingerprint(key)
    this.st = stateOf(this.fp)
    this.now = d.now ?? Date.now
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.defer = d.defer ?? ((p) => void p.catch(() => undefined))
    this.fetchFn = d.fetchFn ?? ((...a) => fetch(...a))
  }

  /** The ledger of the configured key, or null when there is no key (stand-in staging: nothing is paid). */
  static of(env: Env, d: LedgerDeps = {}): Ledger | null {
    return env.NEARAI_API_KEY ? new Ledger(env.TS_KV, env.NEARAI_API_KEY, limitsOf(env), d) : null
  }

  /** Spent so far = flushed (KV, all isolates) + unflushed + reserved here. Throws LedgerClosed when KV cannot be read. */
  private async view(day: string): Promise<View> {
    let total: Agg, today: Agg
    try { [total, today] = await readAggs(this.kv, this.fp, day) } catch { throw new LedgerClosed('ledger_unavailable', null) }
    const v: View = { spent: total.n, pub: total.pub, todayPub: today.pub }
    for (const p of [this.st.pending, this.st.inflight]) {
      if (!p) continue
      v.spent += p.total.n
      v.pub += p.total.pub
      v.todayPub += p.days[day]?.pub ?? 0
    }
    for (const h of this.st.holds.values()) {
      v.spent += h.n
      if (h.pub) { v.pub += h.n; if (h.day === day) v.todayPub += h.n }
    }
    return v
  }

  /** Would one more call costing `worst` fit? Hard stop first, then the public caps (public traffic only). */
  gate(v: View, worst: number, who: Who): Gate {
    const L = this.limits
    const shut = (reason: Reason): Gate => ({ open: false, reason, resetsAt: reason === 'public_daily' ? nextMidnight(this.now()) : null })
    if (this.st.broken) return shut('ledger_unavailable')
    if (v.spent + worst > L.budget) return shut('budget')
    if (who === 'public' && v.pub + worst > L.publicTotal) return shut('public_total')
    if (who === 'public' && v.todayPub + worst > L.publicDaily) return shut('public_daily')
    return { open: true, reason: null, resetsAt: null }
  }

  /** Reserve the worst case of one call. Throws LedgerClosed (with the reason) when it does not fit or KV is unhealthy. */
  reserve(kind: PaidKind, model: string, who: Who): Promise<Hold> {
    return serialize(`ledger:${this.fp}`, async () => {
      if (this.st.broken && this.now() - this.st.flushedAt >= WRITE_GAP_MS) await this.flush().catch(() => undefined) // retry the failed write first
      const price = priceOf(await loadPrices(this.kv, this.fetchFn), model)
      const worst = worstNano(kind, price)
      const day = dayOf(this.now())
      const g = this.gate(await this.view(day), worst, who)
      if (!g.open) throw new LedgerClosed(g.reason!, g.resetsAt)
      const id = ++seq
      this.st.holds.set(id, { n: worst, pub: who === 'public', day })
      return { id, kind, model, who, price, worst, day, done: false }
    })
  }

  /**
   * Settle a reservation: `Usage` = real cost from the response (missing token counts = worst case), 'worst' = the call may
   * have been billed but its cost is unknown, 'free' = it was not billed (refused before the request, upstream error status).
   * Never throws: a failed KV write is kept in memory and closes the ledger until it goes through.
   */
  async settle(h: Hold, outcome: Usage | 'worst' | 'free'): Promise<void> {
    if (h.done) return
    h.done = true
    const usage = typeof outcome === 'object' ? outcome : null
    const n = outcome === 'free' ? 0 : outcome === 'worst' ? h.worst : usageNano(h.kind, h.price, usage) ?? h.worst
    if (n > 0) {
      record(this.st.pending, h.day, h.kind, n, h.who === 'public', 1, {
        ts: this.now(), kind: h.kind, model: h.model, in: usage?.prompt_tokens ?? 0, out: usage?.completion_tokens ?? 0, usd: toUsd(n), who: h.who,
      })
    }
    this.st.holds.delete(h.id) // after recording: the spend never disappears from the view between the two
    if (n > 0) await this.persist()
  }

  /** Charge spend that happened elsewhere (contract forges seen by the tick). No reservation: it is already spent. */
  async charge(kind: PaidKind, model: string, who: Who, nano: number, calls: number): Promise<void> {
    if (!(nano > 0)) return
    record(this.st.pending, dayOf(this.now()), kind, Math.round(nano), who === 'public', calls, { ts: this.now(), kind, model, in: 0, out: 0, usd: toUsd(nano), who })
    await this.persist()
  }

  /** Write now when the per-key gap allows (and wait for it), else once the gap is over (coalescing every settle in it). */
  private async persist(): Promise<void> {
    const wait = this.st.flushedAt + WRITE_GAP_MS - this.now()
    if (wait <= 0 && !this.st.flushing) { await this.flush().catch(() => undefined); return }
    if (this.st.scheduled) return
    this.st.scheduled = true
    this.defer(this.sleep(Math.max(wait, 0)).then(() => { this.st.scheduled = false; return this.flush() }).catch(() => undefined))
  }

  /** Push every unflushed delta to KV. Throws when part of it could not be written (that part stays pending). */
  async flush(): Promise<void> {
    const st = this.st
    while (st.flushing) await st.flushing.catch(() => undefined)
    if (isEmpty(st.pending)) return
    const delta = st.pending
    st.pending = emptyPending()
    st.inflight = delta
    st.flushing = (async () => {
      const failed = await writeDelta(this.kv, this.fp, delta)
      st.flushedAt = this.now()
      mergePending(st.pending, failed) // before inflight is cleared: the unwritten part is never out of the view
      st.inflight = null
      st.broken = !isEmpty(failed)
      if (st.broken) throw new Error('ledger write failed')
    })().finally(() => { st.flushing = null; st.inflight = null })
    return st.flushing
  }

  /** What /api/state shows: can a public compile (and a public portrait) go through now, and how much is left. */
  async status(compileModel: string, imageModel: string): Promise<{ forge: ForgeStatus; portraits: { open: boolean } }> {
    const L = this.limits
    const day = dayOf(this.now())
    let v: View
    try { v = await this.view(day) } catch {
      return { forge: { open: false, reason: 'ledger_unavailable', resetsAt: null, spentUsd: 0, budgetUsd: toUsd(L.budget), publicLeftUsd: 0 }, portraits: { open: false } }
    }
    const prices = await peekPrices(this.kv) // read-only: never a network call from /api/state
    const g = this.gate(v, worstNano('compile', priceOf(prices, compileModel)), 'public')
    const left = Math.max(0, Math.min(L.publicTotal - v.pub, L.publicDaily - v.todayPub, L.budget - v.spent))
    return {
      forge: { open: g.open, reason: g.reason, resetsAt: g.resetsAt, spentUsd: toUsd(v.spent), budgetUsd: toUsd(L.budget), publicLeftUsd: toUsd(left) },
      portraits: { open: this.gate(v, worstNano('portrait', priceOf(prices, imageModel)), 'public').open },
    }
  }
}

export interface ForgeStatus { open: boolean; reason: Reason | null; resetsAt: string | null; spentUsd: number; budgetUsd: number; publicLeftUsd: number }
