// The NEAR AI spend ledger (docs/BUDGET.md "Worker ledger"): pricing, fingerprints, reserve/settle, caps, races, KV failures.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemKV, ROOT } from './helpers'
import { fingerprint, Ledger, LedgerClosed, limitsOf, whoOf, WRITE_GAP_MS, type LedgerDeps } from '../functions/_lib/ledger'
import { parseAgg, totalKey, dayKey, logKey, type Entry } from '../functions/_lib/ledgerStore'
import { FALLBACK_PRICES, parseListing, priceOf, toNano, worstNano } from '../functions/_lib/pricing'
import type { Env } from '../functions/_lib/env'

const GLM = 'z-ai/glm-5.3-flash'
const FLUX = 'black-forest-labs/FLUX.2-klein-4B'
const KEY = 'sk-title-shot-test-key-0001'
const vector = JSON.parse(readFileSync(join(ROOT, 'vectors/nearai-real-z_ai_glm_5_3_flash-cactus-low.json'), 'utf8'))
const noListing = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)

function rig(over: Partial<Env> = {}, d: LedgerDeps = {}) {
  const kv = new MemKV()
  const clock = { t: T0 }
  const deferred: Promise<unknown>[] = []
  const deps: LedgerDeps = { fetchFn: noListing, now: () => clock.t, sleep: async (ms) => { clock.t += ms }, defer: (p) => void deferred.push(p), ...d }
  const env: Env = { TS_KV: kv, NEARAI_API_KEY: KEY, ...over }
  const make = (e: Env = env) => Ledger.of(e, deps)!
  return { kv, clock, env, make, deferred, settleAll: () => Promise.all(deferred.splice(0)) }
}
const total = (kv: MemKV, fp: string) => parseAgg((kv.store.get(totalKey(fp)) as string) ?? null)

describe('pricing', () => {
  it('fallback table matches docs/BUDGET.md and the recorded compile costs exactly what NEAR AI billed', () => {
    expect(FALLBACK_PRICES[GLM]).toEqual({ in: 0.08e-6, out: 0.5e-6, image: 0 })
    expect(FALLBACK_PRICES[FLUX]!.image).toBe(0.012)
    const p = priceOf({}, GLM)
    expect(worstNano('compile', p)).toBe(toNano(0.00064))
    expect(worstNano('portrait', priceOf({}, FLUX))).toBe(toNano(0.012))
    const { prompt_tokens, completion_tokens } = vector.usage
    expect(toNano(prompt_tokens * p.in + completion_tokens * p.out)).toBe(toNano(vector.usd)) // 0.00028946
  })
  it('the /v1/models listing wins field by field; zero, negative and junk prices are ignored; unknown models are expensive', () => {
    const t = parseListing({ data: [{ id: GLM, pricing: { prompt: '0.0000001', completion: '0', image: 'x' } }, { id: FLUX, pricing: { image: 0.02 } }, { id: 'n/a' }] })
    expect(t).toEqual({ [GLM]: { in: 1e-7 }, [FLUX]: { image: 0.02 } })
    expect(priceOf(t, GLM)).toEqual({ in: 1e-7, out: 0.5e-6, image: 0 })
    expect(priceOf(t, FLUX).image).toBe(0.02)
    expect(worstNano('compile', priceOf({}, 'some/new-model'))).toBeGreaterThan(toNano(0.01))
  })
  it('limits: defaults 2.5 / 0.05 / 0.25, env overrides, junk falls back', () => {
    expect(limitsOf({ TS_KV: new MemKV() })).toEqual({ budget: toNano(2.5), publicDaily: toNano(0.05), publicTotal: toNano(0.25) })
    expect(limitsOf({ TS_KV: new MemKV(), NEARAI_BUDGET_USD: '9', NEARAI_PUBLIC_DAILY_USD: '1', NEARAI_PUBLIC_TOTAL_USD: 'lots' })).toEqual({ budget: toNano(9), publicDaily: toNano(1), publicTotal: toNano(0.25) })
  })
})

describe('fingerprint: the ledger is keyed by sha256(key)[0..16], never the key', () => {
  it('is the first 16 hex of sha256 and no KV key or value contains the key', async () => {
    expect(fingerprint(KEY)).toBe(createHash('sha256').update(KEY).digest('hex').slice(0, 16))
    const r = rig()
    const l = r.make()
    await l.settle(await l.reserve('compile', GLM, 'public'), vector.usage)
    for (const [k, v] of r.kv.store) { expect(k).not.toContain(KEY); expect(String(v)).not.toContain(KEY) }
    expect([...r.kv.store.keys()].filter((k) => k.startsWith('ledger:')).every((k) => k.startsWith(`ledger:${l.fp}:`))).toBe(true)
  })
  it('a new key gets a fresh ledger: the old key closed at its hard stop, the new one open', async () => {
    const r = rig({ NEARAI_BUDGET_USD: '0.001' })
    const a = r.make()
    await a.settle(await a.reserve('compile', GLM, 'owner'), 'worst')
    await expect(a.reserve('compile', GLM, 'owner')).rejects.toMatchObject({ reason: 'budget' })
    const b = r.make({ ...r.env, NEARAI_API_KEY: 'sk-rotated-key-0002' })
    expect(b.fp).not.toBe(a.fp)
    const h = await b.reserve('compile', GLM, 'owner')
    expect(h.worst).toBe(toNano(0.00064))
    expect(total(r.kv, b.fp).n).toBe(0)
  })
})

describe('reserve, then settle to the real cost', () => {
  it('settles to usage x price, records day + total aggregates and the recent log', async () => {
    const r = rig()
    const l = r.make()
    const h = await l.reserve('compile', GLM, 'public')
    expect(h.worst).toBe(toNano(0.00064))
    await l.settle(h, vector.usage)
    const t = total(r.kv, l.fp)
    expect(t).toMatchObject({ n: toNano(0.00028946), pub: toNano(0.00028946), calls: 1, kinds: { compile: toNano(0.00028946) } })
    expect(parseAgg(r.kv.store.get(dayKey(l.fp, '2026-11-14')) as string).n).toBe(toNano(0.00028946))
    const log = JSON.parse(r.kv.store.get(logKey(l.fp)) as string) as Entry[]
    expect(log[0]).toMatchObject({ ts: T0, kind: 'compile', model: GLM, in: 2712, out: 145, usd: 0.00028946, who: 'public' })
    await l.settle(h, vector.usage) // settling twice is a no-op
    expect(total(r.kv, l.fp).calls).toBe(1)
  })
  it('no usage means worst case; "free" records nothing; a portrait costs the flat image price', async () => {
    const r = rig()
    const l = r.make()
    await l.settle(await l.reserve('compile', GLM, 'public'), {})
    r.clock.t += WRITE_GAP_MS
    await l.settle(await l.reserve('compile', GLM, 'public'), 'free')
    await l.settle(await l.reserve('portrait', FLUX, 'public'), { images: 1 })
    await r.settleAll()
    expect(total(r.kv, l.fp)).toMatchObject({ n: toNano(0.00064) + toNano(0.012), calls: 2, kinds: { compile: toNano(0.00064), portrait: toNano(0.012) } })
  })
  it('uses the listing price when /v1/models answers', async () => {
    const listing = (async () => new Response(JSON.stringify({ data: [{ id: FLUX, pricing: { image: '0.02' } }] }))) as unknown as typeof fetch
    const r = rig({}, { fetchFn: listing })
    const l = r.make()
    const h = await l.reserve('portrait', FLUX, 'public')
    expect(h.worst).toBe(toNano(0.02))
  })
  it('settles inside one write gap are coalesced into one write per key', async () => {
    const wakers: (() => void)[] = []
    const r: ReturnType<typeof rig> = rig({}, { sleep: (ms) => new Promise<void>((res) => wakers.push(() => { r.clock.t += ms; res() })) })
    const l = r.make()
    const before = r.kv.puts
    await l.settle(await l.reserve('compile', GLM, 'public'), vector.usage) // writes total, day, log
    const first = r.kv.puts - before
    expect(first).toBe(3)
    for (let i = 0; i < 4; i++) await l.settle(await l.reserve('compile', GLM, 'public'), vector.usage)
    expect(r.kv.puts - before).toBe(first) // nothing written yet, one flush scheduled
    expect(r.deferred.length).toBe(1)
    wakers.splice(0).forEach((w) => w())
    await r.settleAll()
    expect(r.kv.puts - before).toBe(first * 2)
    expect(total(r.kv, l.fp).calls).toBe(5)
  })
})

describe('caps: hard stop for everyone, public caps for public traffic only', () => {
  it('public daily cap (0.05 = 78 worst-case compiles) closes until midnight UTC; owner traffic still passes', async () => {
    const r = rig()
    const l = r.make()
    for (let i = 0; i < 78; i++) await l.reserve('compile', GLM, 'public')
    const err = await l.reserve('compile', GLM, 'public').catch((e) => e)
    expect(err).toBeInstanceOf(LedgerClosed)
    expect(err).toMatchObject({ reason: 'public_daily', resetsAt: '2026-11-15T00:00:00.000Z' })
    await expect(l.reserve('compile', GLM, 'owner')).resolves.toBeTruthy()
    r.clock.t += 86_400_000 // a new UTC day: the daily cap reopens (the 0.25 lifetime cap is not reached yet)
    await expect(l.reserve('compile', GLM, 'public')).resolves.toBeTruthy()
  })
  it('public lifetime cap and the hard stop (which owner traffic cannot pass either)', async () => {
    const r = rig({ NEARAI_PUBLIC_DAILY_USD: '1', NEARAI_PUBLIC_TOTAL_USD: '0.001', NEARAI_BUDGET_USD: '0.0015' })
    const l = r.make()
    await l.settle(await l.reserve('compile', GLM, 'public'), 'worst')
    await expect(l.reserve('compile', GLM, 'public')).rejects.toMatchObject({ reason: 'public_total', resetsAt: null })
    await l.reserve('compile', GLM, 'owner')
    await expect(l.reserve('compile', GLM, 'owner')).rejects.toMatchObject({ reason: 'budget' })
    await expect(l.reserve('compile', GLM, 'tick')).rejects.toMatchObject({ reason: 'budget' })
  })
  it('a released (free) reservation gives its room back', async () => {
    const r = rig({ NEARAI_BUDGET_USD: '0.001' })
    const l = r.make()
    const h = await l.reserve('compile', GLM, 'owner')
    await expect(l.reserve('compile', GLM, 'owner')).rejects.toMatchObject({ reason: 'budget' })
    await l.settle(h, 'free')
    await expect(l.reserve('compile', GLM, 'owner')).resolves.toBeTruthy()
  })
  it('two reservations racing for the last slot: exactly one wins', async () => {
    const r = rig({ NEARAI_BUDGET_USD: '0.001' })
    const [a, b] = await Promise.allSettled([r.make().reserve('compile', GLM, 'owner'), r.make().reserve('compile', GLM, 'owner')])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
  })
  it('spend flushed by another isolate (KV) counts', async () => {
    const r = rig({ NEARAI_BUDGET_USD: '0.001' })
    const fp = fingerprint(KEY)
    r.kv.store.set(totalKey(fp), JSON.stringify({ n: toNano(0.0009), pub: 0, calls: 3, kinds: {} }))
    await expect(r.make().reserve('compile', GLM, 'owner')).rejects.toMatchObject({ reason: 'budget' })
  })
  it('whoOf: only a correct x-tick-secret is owner traffic', () => {
    const env = { TS_KV: new MemKV(), TICK_SECRET: 'tick-secret-1' }
    const req = (h: Record<string, string>) => new Request('https://t.test/api/preview', { headers: h })
    expect(whoOf(req({ 'x-tick-secret': 'tick-secret-1' }), env)).toBe('owner')
    expect(whoOf(req({ 'x-tick-secret': 'wrong' }), env)).toBe('public')
    expect(whoOf(req({}), env)).toBe('public')
    expect(whoOf(req({ 'x-tick-secret': '' }), { TS_KV: env.TS_KV })).toBe('public')
  })
})

describe('KV failures fail closed', () => {
  it('an unreadable ledger refuses every reservation (and status reports it)', async () => {
    const r = rig()
    r.kv.get = (async () => { throw new Error('kv down') }) as MemKV['get']
    await expect(r.make().reserve('compile', GLM, 'owner')).rejects.toMatchObject({ reason: 'ledger_unavailable' })
    const s = await r.make().status(GLM, FLUX)
    expect(s.forge).toMatchObject({ open: false, reason: 'ledger_unavailable' })
    expect(s.portraits.open).toBe(false)
  })
  it('a corrupted aggregate is not "nothing spent"', async () => {
    const r = rig()
    r.kv.store.set(totalKey(fingerprint(KEY)), '{"n":"lots"}')
    await expect(r.make().reserve('compile', GLM, 'owner')).rejects.toMatchObject({ reason: 'ledger_unavailable' })
  })
  it('a failed write keeps the spend in memory, closes the ledger, and the retry writes it once', async () => {
    const r = rig()
    const l = r.make()
    const put = r.kv.put.bind(r.kv)
    r.kv.put = (async () => { throw new Error('kv write failed') }) as MemKV['put']
    await l.settle(await l.reserve('compile', GLM, 'public'), vector.usage) // never throws to the caller
    await expect(l.reserve('compile', GLM, 'public')).rejects.toMatchObject({ reason: 'ledger_unavailable' })
    r.kv.put = put
    r.clock.t += WRITE_GAP_MS
    await l.reserve('compile', GLM, 'public') // retries the write first, then reserves
    expect(total(r.kv, l.fp)).toMatchObject({ n: toNano(0.00028946), calls: 1 })
  })
})

describe('status for /api/state', () => {
  it('reports spend, budget and the public room left', async () => {
    const r = rig()
    const l = r.make()
    await l.settle(await l.reserve('compile', GLM, 'public'), vector.usage)
    const s = await l.status(GLM, FLUX)
    expect(s.forge).toEqual({ open: true, reason: null, resetsAt: null, spentUsd: 0.00028946, budgetUsd: 2.5, publicLeftUsd: 0.04971054 })
    expect(s.portraits.open).toBe(true)
    for (let i = 0; i < 60; i++) await l.reserve('compile', GLM, 'public') // 0.0384 reserved: 0.0113 left today
    const p = await l.status(GLM, FLUX)
    expect(p.forge.open).toBe(true) // a compile (0.00064) still fits
    expect(p.portraits.open).toBe(false) // a portrait (0.012) does not
    expect(p.forge.publicLeftUsd).toBeCloseTo(0.01131054, 8)
  })
  it('closed for the day: reason public_daily with the next UTC midnight', async () => {
    const r = rig({ NEARAI_PUBLIC_DAILY_USD: '0.0005' })
    const s = await r.make().status(GLM, FLUX)
    expect(s.forge).toMatchObject({ open: false, reason: 'public_daily', resetsAt: '2026-11-15T00:00:00.000Z', publicLeftUsd: 0.0005 })
  })
})
