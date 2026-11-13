// Payout signing back-off after soft failures, and the purse funding record (save before broadcast, never broadcast unsaved).
import { describe, expect, it } from 'vitest'
import { belt, season, payout, ns, NOW_MS } from './fixtures'
import { run, setup, world, methods, type World } from './tick-rig'
import { MAX_SIGN_ATTEMPTS, signBackoffMs, signFailKey } from '../functions/_lib/tickPayouts'
import { fundPurse } from '../functions/_lib/purse'
import { getJson } from '../functions/_lib/cache'
import type { MemKV } from './helpers'

const MIN = 60_000
const closed = () => season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1], closes_at: ns(NOW_MS - 10_000) })
const unsigned = (over: Partial<World> = {}) => world({ belts: [belt({ season: closed() })], payouts: { '1:2': [payout(1)] }, softSign: true, ...over })
// without Vance the belt is never re-opened, so the clock can run for hours without the promoter step
const NO_VANCE = { vance: false }
const signCalls = (calls: { method: string }[]) => calls.filter((c) => c.method === 'sign_payout').length

describe('sign_payout soft failures back off 1, 2, 4, 8 minutes and stop after 6 attempts', () => {
  it('the schedule is 1, 2, 4, 8, 8 minutes and the cap is 6 attempts', () => {
    expect([1, 2, 3, 4, 5].map((n) => signBackoffMs(n) / MIN)).toEqual([1, 2, 4, 8, 8])
    expect(MAX_SIGN_ATTEMPTS).toBe(6)
  })

  it('a call that returns no raw tx is logged as a soft failure and not repeated before the back-off ends', async () => {
    const w = unsigned()
    const { d, calls } = setup(w, NO_VANCE)
    const first = await run(d)
    expect(signCalls(calls)).toBe(1)
    expect(first.steps.find((s) => s.action === 'sign_payout#1' && s.detail?.startsWith('SIGN_SOFT_FAIL'))).toMatchObject({ ok: false })
    expect(first.steps.some((s) => s.action === 'sign_payout#1' && s.ok)).toBe(false)
    for (const t of [10_000, 59_000]) { w.now = NOW_MS + t; await run(d) }
    expect(signCalls(calls)).toBe(1) // inside the first minute: no call at all
    w.now = NOW_MS + MIN
    await run(d)
    expect(signCalls(calls)).toBe(2)
  })

  it('six attempts at 0, 1, 3, 7, 15 and 23 minutes, then SIGN_GAVE_UP on every tick with no further calls', async () => {
    const w = unsigned()
    const { d, calls, kv } = setup(w, NO_VANCE)
    const at = [0, 1, 3, 7, 15, 23].map((m) => m * MIN)
    for (const t of at) {
      w.now = NOW_MS + t
      await run(d)
      w.now = NOW_MS + t + 30_000 // a tick half a minute later is always inside the back-off
      await run(d)
    }
    expect(signCalls(calls)).toBe(6)
    expect(await getJson(kv, signFailKey(1))).toMatchObject({ n: 6 })
    w.now = NOW_MS + 24 * 60 * MIN
    const log = await run(d)
    expect(signCalls(calls)).toBe(6)
    const gave = log.steps.find((s) => s.action === 'sign_payout#1')
    expect(gave).toMatchObject({ ok: false })
    expect(gave!.detail).toMatch(/^SIGN_GAVE_UP/)
  })

  it('the sixth failure itself already reports SIGN_GAVE_UP', async () => {
    const w = unsigned()
    const { d, kv } = setup(w, NO_VANCE)
    await (kv as MemKV).put(signFailKey(1), JSON.stringify({ n: 5, next: 0 }))
    const log = await run(d)
    expect(log.steps.find((s) => s.action === 'sign_payout#1' && s.detail?.startsWith('SIGN_GAVE_UP'))).toBeTruthy()
  })

  it('SIGN_GAVE_UP is a stable code the public state shows; clearing the KV key (scripts/reset-sign-payout.sh) resumes signing', async () => {
    const w = unsigned({ softSign: false })
    const { d, calls, kv } = setup(w, NO_VANCE)
    await (kv as MemKV).put(signFailKey(1), JSON.stringify({ n: 6, next: 0 }))
    await run(d)
    expect(signCalls(calls)).toBe(0)
    await kv.delete(signFailKey(1))
    await run(d)
    expect(signCalls(calls)).toBe(1)
  })

  it('a success clears the failure record', async () => {
    const w = unsigned()
    const { d, calls, kv } = setup(w, NO_VANCE)
    await run(d)
    expect(await getJson(kv, signFailKey(1))).toMatchObject({ n: 1 })
    w.softSign = false
    w.now = NOW_MS + MIN
    const log = await run(d)
    expect(signCalls(calls)).toBe(2)
    expect(log.steps.find((s) => s.action === 'sign_payout#1')).toMatchObject({ ok: true })
    expect(await getJson(kv, signFailKey(1))).toBeNull()
  })

  it('each payout backs off on its own', async () => {
    const w = world({ belts: [belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1, 2], closes_at: ns(NOW_MS - 10_000) }) })], payouts: { '1:2': [payout(1), payout(2)] }, softSign: true })
    const { d, calls, kv } = setup(w, NO_VANCE)
    await run(d)
    expect(signCalls(calls)).toBe(2)
    await (kv as MemKV).put(signFailKey(1), JSON.stringify({ n: 6, next: 0 })) // payout 1 gave up, payout 2 did not
    w.now = NOW_MS + MIN
    await run(d)
    expect(calls.filter((c) => c.method === 'sign_payout').map((c) => c.args.payout_id)).toEqual([1, 2, 2])
  })

  it('a hard failure (the contract refused) is not a soft failure and is not backed off', async () => {
    const w = unsigned({ softSign: false, failures: { sign_payout: 'Smart contract panicked: E_SIGNING' } })
    const { d, calls, kv } = setup(w, NO_VANCE)
    await run(d)
    await run(d)
    expect(signCalls(calls)).toBe(2)
    expect(await getJson(kv, signFailKey(1))).toBeNull()
  })
})

describe('the funding record is saved before the broadcast, and a failed save blocks it', () => {
  const closedBelt = () => belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', closes_at: ns(NOW_MS - 120_000) }) })
  const TO = '0x' + 'cd'.repeat(20)

  it('fundPurse: a save that throws means nothing is broadcast and the result is FUND_SAVE_FAILED', async () => {
    const { d, sent } = setup(world({ belts: [closedBelt()], autoMine: true }))
    const r = await fundPurse({ near: d.near, base: d.base, vance: d.vance!, mpc: d.mpc }, TO, 2_000_000_000_000_000n, null, async () => { throw new Error('KV PUT failed: 429') })
    expect(r).toMatchObject({ ok: false, code: 'FUND_SAVE_FAILED' })
    expect(sent.length).toBe(0)
  })

  it('a tick whose funding save fails logs FUND_SAVE_FAILED, broadcasts nothing, opens nothing, and the next tick (KV healthy) funds exactly once', async () => {
    const w = world({ belts: [closedBelt()], autoMine: true })
    const { d, sent, calls, kv } = setup(w)
    const put = (kv as MemKV).put.bind(kv)
    let broken = true
    ;(kv as MemKV).put = async (k: string, v: string | ArrayBuffer, o?: { expirationTtl?: number }) => { if (broken && k.startsWith('fund:')) throw new Error('KV PUT failed: 429'); return put(k, v) }
    const first = await run(d)
    expect(first.steps.find((s) => s.action === 'fund_purse')).toMatchObject({ ok: false })
    expect(first.steps.find((s) => s.action === 'fund_purse')!.detail).toMatch(/^FUND_SAVE_FAILED/)
    expect(sent.length).toBe(0)
    expect(methods(calls)).not.toContain('open_season')
    broken = false
    const second = await run(d)
    expect(sent.length).toBe(1)
    expect(second.steps.find((s) => s.action === 'fund_purse')).toMatchObject({ ok: true })
    expect(methods(calls)).toContain('open_season')
    w.belts = [belt()] // the season is now open on chain
    await run(d) // later ticks never fund the same purse again
    expect(sent.length).toBe(1)
  })
})
