import { describe, expect, it } from 'vitest'
import { belt, season, payout, ns, NOW_MS, CONTRACT } from './fixtures'
import { run, setup, world, methods, later } from './tick-rig'
import { runTick, THROTTLE_MS } from '../functions/_lib/tick'
import { trackKey } from '../functions/_lib/tickPayouts'
import { txHashOf } from '../functions/_lib/evm'
import { getJson, putJson, scoped } from '../functions/_lib/cache'
import type { PayoutTrack } from '../functions/_lib/tickTypes'
import type { RawPayout, RawSeason } from '../src/game/chain/views'

describe('the tick is throttled, locked and never throws', () => {
  it('a second run within 20 s is skipped, with force it runs', async () => {
    const { d } = setup(world({ belts: [] }))
    const first = await runTick(d)
    expect(first.skipped).toBeUndefined()
    const second = await runTick(d)
    expect(second.skipped).toBe('throttled')
    expect(THROTTLE_MS).toBe(20_000)
    expect((await runTick(d, { force: true })).skipped).toBeUndefined()
  })
  it('an unexpired lock means another tick is running', async () => {
    const w = world({ belts: [] })
    const { d, kv } = setup(w)
    await putJson(kv, scoped(CONTRACT, 'tick:lock'), NOW_MS - 5000)
    expect((await runTick(d, { force: true })).skipped).toBe('running')
    await putJson(kv, scoped(CONTRACT, 'tick:lock'), NOW_MS - 120_000)
    expect((await runTick(d, { force: true })).skipped).toBeUndefined()
  })
  it('a failing chain is logged, the lock is released and the run is recorded', async () => {
    const w = world()
    const { d, kv } = setup(w)
    ;(d.chain as any).belts = async () => { throw new Error('rpc down') }
    const log = await run(d)
    expect(log.steps[0]).toMatchObject({ action: 'tick', ok: false })
    expect(await getJson(kv, scoped(CONTRACT, 'tick:lock'))).toBe(0)
    expect(await getJson(kv, scoped(CONTRACT, 'tick:last'))).toMatchObject({ at: NOW_MS })
  })
  it('a step that throws does not stop the other belts', async () => {
    const w = world({ belts: [belt({ id: 1, season: later(season(), 1000) }), belt({ id: 2, season: later(season(), 1000) })] })
    const { d, calls } = setup(w)
    const orig = (d.sponsor as any).call
    let n = 0
    ;(d.sponsor as any).call = async (...a: any[]) => { if (n++ === 0) throw new Error('boom'); return orig(...a) }
    const log = await run(d)
    expect(log.steps.some((s) => s.action === 'bell' && !s.ok)).toBe(true)
    expect(calls.filter((c) => c.method === 'close_season').map((c) => c.args.belt_id)).toEqual([2])
  })
})

describe('the bell', () => {
  it('rings close_season once the season is over and nothing is forging', async () => {
    const { d, calls } = setup(world({ belts: [belt({ season: later(season(), 1000) })] }))
    await run(d)
    expect(calls.filter((c) => c.method === 'close_season')).toEqual([{ who: 'play.titleshot.testnet', receiver: CONTRACT, method: 'close_season', args: { belt_id: 1 }, deposit: 0n }])
  })
  it('does not ring before the bell, with a bout still forging, on a closed season or without a sponsor', async () => {
    for (const [b, opts] of [[belt(), {}], [belt({ season: season({ closes_at: ns(NOW_MS - 1000), pending: 1 }) }), {}], [belt({ season: season({ state: 'Closed', closes_at: ns(NOW_MS - 1000) }) }), {}], [belt({ season: season({ closes_at: ns(NOW_MS - 1000) }) }), { sponsor: false }]] as const) {
      const { d, calls } = setup(world({ belts: [b] }), opts)
      await run(d)
      expect(methods(calls)).not.toContain('close_season')
    }
  })
  it('a refused close (E_PENDING_BOUTS) is logged with its code', async () => {
    const { d } = setup(world({ belts: [belt({ season: later(season(), 1000) })], failures: { close_season: 'Smart contract panicked: E_PENDING_BOUTS' } }))
    const log = await run(d)
    expect(log.steps.find((s) => s.action === 'close_season')).toMatchObject({ ok: false, detail: 'E_PENDING_BOUTS' })
  })
})

describe('payouts: sign with estimated fees, broadcast, track, bump', () => {
  const closed = (extra: Partial<RawSeason> = {}) => season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1], closes_at: ns(NOW_MS - 10_000), ...extra })
  const withPayouts = (p: RawPayout[], s: RawSeason = closed()) => world({ belts: [belt({ season: s })], payouts: { '1:2': p } })

  it('signs an unsigned payout with +20% gas and 3x base fee + tip inside the contract bounds', async () => {
    const { d, calls } = setup(withPayouts([payout(1)]))
    await run(d)
    const c = calls.find((x) => x.method === 'sign_payout')!
    expect(c.args).toEqual({ payout_id: 1, max_fee_per_gas: String(100_000_000n * 3n + 1_000_000n), max_priority_fee_per_gas: '1000000', gas_limit: 25_200 })
    expect(c.who).toBe('play.titleshot.testnet')
  })
  it('skips payouts with no address (claimable), zero amount, or a signature already in flight', async () => {
    const { d, calls } = setup(withPayouts([payout(1, { to: null }), payout(2, { amount_wei: '0' }), payout(3, { signing: true })]))
    await run(d)
    expect(methods(calls)).not.toContain('sign_payout')
  })
  it('refuses dust (the contract would answer E_DUST) and says so', async () => {
    const { d, calls } = setup(withPayouts([payout(1, { amount_wei: '1000' })]))
    const log = await run(d)
    expect(methods(calls)).not.toContain('sign_payout')
    expect(log.steps.find((s) => s.action === 'sign_payout#1')).toMatchObject({ ok: false })
  })
  it('without a recorded purse address it waits instead of signing', async () => {
    const { d, calls } = setup(withPayouts([payout(1)], closed({ purse: { chain_id: 84532, path: 'belt-1-s2', amount_wei: '1', address: null, next_nonce: 0 } })))
    const log = await run(d)
    expect(methods(calls)).not.toContain('sign_payout')
    expect(log.steps.some((s) => s.detail?.includes('E_NO_ADDRESS'))).toBe(true)
  })
  it('broadcasts a signed raw tx once and records the hash; a mined receipt ends it', async () => {
    const raw = '0x02f8aabbcc'
    const w = withPayouts([payout(1, { raw_tx: raw, nonce: 0 })])
    const { d, sent, kv } = setup(w)
    await run(d)
    expect(sent).toEqual([raw])
    const tracked = await getJson<PayoutTrack>(kv, trackKey(CONTRACT, 1))
    expect(tracked).toMatchObject({ hash: txHashOf(raw), status: 'sent' })
    w.receipts[txHashOf(raw)] = { status: '0x1' }
    await run(d)
    expect(await getJson<PayoutTrack>(kv, trackKey(CONTRACT, 1))).toMatchObject({ status: 'mined' })
    const n = sent.length
    await run(d)
    expect(sent.length).toBe(n) // terminal: no more broadcasts
  })
  it('a reverted receipt is recorded as reverted', async () => {
    const raw = '0x02f8aa'
    const w = withPayouts([payout(1, { raw_tx: raw, nonce: 0 })])
    w.receipts[txHashOf(raw)] = { status: '0x0' }
    const { d, kv } = setup(w)
    await run(d)
    expect(await getJson<PayoutTrack>(kv, trackKey(CONTRACT, 1))).toMatchObject({ status: 'reverted' })
  })
  it('"already known" and "nonce too low" mean an earlier broadcast landed: not an error', async () => {
    const { d, kv } = setup(Object.assign(withPayouts([payout(1, { raw_tx: '0x02f8ab', nonce: 0 })]), { broadcastError: 'already known' }))
    const log = await run(d)
    expect(log.steps.find((s) => s.action === 'broadcast#1')).toMatchObject({ ok: true, detail: 'already-known' })
    expect(await getJson<PayoutTrack>(kv, trackKey(CONTRACT, 1))).toMatchObject({ status: 'sent' })
  })
  it('a transient broadcast failure is retried next tick, not recorded as sent', async () => {
    const { d, kv } = setup(Object.assign(withPayouts([payout(1, { raw_tx: '0x02f8ac', nonce: 0 })]), { broadcastError: 'internal error' }))
    const log = await run(d)
    expect(log.steps.some((s) => s.ok === false)).toBe(true)
    expect(await getJson(kv, trackKey(CONTRACT, 1))).toBeNull()
  })
  it('a tx stuck for 10 minutes is re-signed with a strictly higher maxFee, then the old hash is still watched', async () => {
    const raw = '0x02f8ad'
    const w = withPayouts([payout(1, { raw_tx: raw, nonce: 0, max_fee_per_gas: '300100000', gas_limit: 25200 })])
    const { d, calls, kv } = setup(w)
    await putJson(kv, trackKey(CONTRACT, 1), { hash: txHashOf(raw), status: 'sent', at: NOW_MS - 11 * 60_000 } satisfies PayoutTrack)
    ;(d.chain as any).season = async () => closed()
    await run(d)
    const c = calls.find((x) => x.method === 'sign_payout')!
    expect(BigInt(c.args.max_fee_per_gas)).toBeGreaterThan(300_100_000n)
    expect(BigInt(c.args.max_fee_per_gas) * 1000n).toBeGreaterThanOrEqual(300_100_000n * 1125n)
    expect(c.args.gas_limit).toBe(25_200)
    expect(await getJson(kv, trackKey(CONTRACT, 1))).toMatchObject({ hash: txHashOf(raw), status: 'sent', prior: [txHashOf(raw)] })
  })
})

