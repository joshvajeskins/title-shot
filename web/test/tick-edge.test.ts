import { describe, expect, it } from 'vitest'
import { belt, challenge, ns, NOW_MS, payout, season } from './fixtures'
import { run, setup, world, methods } from './tick-rig'
import { trackKey } from '../functions/_lib/tickPayouts'
import { txHashOf } from '../functions/_lib/evm'
import { bumpedFees } from '../functions/_lib/fees'
import { getJson, putJson } from '../functions/_lib/cache'
import type { PayoutTrack } from '../functions/_lib/tickTypes'
import type { RawChallenge, RawPayout, RawSeason } from '../src/game/chain/views'
import { MAX_FEE_CAP_WEI } from '../src/game/chain/config'

const closed = (extra: Partial<RawSeason> = {}) => season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1], closes_at: ns(NOW_MS - 10_000), ...extra })
const withPayouts = (p: RawPayout[]) => world({ belts: [belt({ season: closed() })], payouts: { '1:2': p } })
const MIN = 60_000

describe('a stuck payout is replaced with both fee cap and tip raised', () => {
  it('bumpedFees raises the cap and the known tip by at least 12.5% (nodes want 10% on both)', () => {
    for (const [m, t] of [[300_100_000n, 1_000_000n], [10n ** 9n, 5n * 10n ** 8n], [9n, 3n]] as const) {
      const b = bumpedFees({ maxFee: m, priority: t })!
      expect(b.maxFee * 1000n).toBeGreaterThanOrEqual(m * 1125n)
      expect(b.priority * 1000n).toBeGreaterThanOrEqual(t * 1125n)
      expect(b.priority).toBeLessThanOrEqual(b.maxFee)
    }
  })
  it('an unknown tip becomes the largest the new cap allows (so it surely rose); the cap stops it', () => {
    const b = bumpedFees({ maxFee: 3_000_000n })!
    expect(b.priority).toBe(b.maxFee)
    expect(bumpedFees({ maxFee: MAX_FEE_CAP_WEI, priority: 1n })).toBeNull()
  })
  it('the tick re-signs with the tip it recorded at signing time, raised', async () => {
    const raw = '0x02f8b1'
    const w = withPayouts([payout(1, { raw_tx: raw, nonce: 0, max_fee_per_gas: '300100000', gas_limit: 25200 })])
    const { d, calls, kv } = setup(w)
    await putJson(kv, trackKey(1), { hash: txHashOf(raw), status: 'sent', at: NOW_MS - 11 * MIN } satisfies PayoutTrack)
    await putJson(kv, 'payoutfee:1', { maxFee: '300100000', priority: '1000000' })
    ;(d.chain as any).season = async () => closed()
    await run(d)
    const c = calls.find((x) => x.method === 'sign_payout')!
    expect(BigInt(c.args.max_fee_per_gas) * 1000n).toBeGreaterThanOrEqual(300_100_000n * 1125n)
    expect(BigInt(c.args.max_fee_per_gas)).toBeGreaterThanOrEqual(BigInt(c.args.max_priority_fee_per_gas))
    expect(BigInt(c.args.max_priority_fee_per_gas) * 1000n).toBeGreaterThanOrEqual(1_000_000n * 1125n)
  })
  it('the tip stays at least 12.5% higher even when the recorded fee does not match (signed elsewhere)', async () => {
    const raw = '0x02f8b2'
    const w = withPayouts([payout(1, { raw_tx: raw, nonce: 0, max_fee_per_gas: '300100000', gas_limit: 25200 })])
    const { d, calls, kv } = setup(w)
    await putJson(kv, trackKey(1), { hash: txHashOf(raw), status: 'sent', at: NOW_MS - 11 * MIN } satisfies PayoutTrack)
    await putJson(kv, 'payoutfee:1', { maxFee: '5', priority: '1' })
    ;(d.chain as any).season = async () => closed()
    await run(d)
    const c = calls.find((x) => x.method === 'sign_payout')!
    expect(c.args.max_priority_fee_per_gas).toBe(c.args.max_fee_per_gas)
  })
  it('after a bump the old hash stays tracked and the 10 minute clock restarts', async () => {
    const raw = '0x02f8b3'
    const w = withPayouts([payout(1, { raw_tx: raw, nonce: 0, max_fee_per_gas: '300100000', gas_limit: 25200 })])
    const { d, kv } = setup(w)
    await putJson(kv, trackKey(1), { hash: txHashOf(raw), status: 'sent', at: NOW_MS - 11 * MIN } satisfies PayoutTrack)
    ;(d.chain as any).season = async () => closed()
    await run(d)
    expect(await getJson<PayoutTrack>(kv, trackKey(1))).toMatchObject({ hash: txHashOf(raw), status: 'sent', at: NOW_MS, prior: [txHashOf(raw)] })
  })
  it('the original tx mined after a bump is found: tracked as mined, never bumped or re-sent again', async () => {
    const oldRaw = '0x02f8c1'
    const newRaw = '0x02f8c2'
    const w = withPayouts([payout(1, { raw_tx: newRaw, nonce: 0, max_fee_per_gas: '400000000', gas_limit: 25200 })])
    w.receipts[txHashOf(oldRaw)] = { status: '0x1' }
    const { d, calls, sent, kv } = setup(w, { vance: false })
    await putJson(kv, trackKey(1), { hash: txHashOf(oldRaw), status: 'sent', at: NOW_MS - 30 * MIN, prior: [txHashOf(oldRaw)] } satisfies PayoutTrack)
    const log = await run(d)
    expect(await getJson<PayoutTrack>(kv, trackKey(1))).toMatchObject({ hash: txHashOf(oldRaw), status: 'mined' })
    expect(log.steps.find((s) => s.action === 'payout#1')).toMatchObject({ ok: true, detail: 'mined', tx: txHashOf(oldRaw) })
    w.now += 40 * MIN
    await run(d)
    expect(sent).toEqual([])
    expect(methods(calls)).not.toContain('sign_payout')
  })
  it('a replacement is broadcast and both hashes are watched; the replacement mining ends it too', async () => {
    const oldRaw = '0x02f8d1'
    const newRaw = '0x02f8d2'
    const w = withPayouts([payout(1, { raw_tx: newRaw, nonce: 0, max_fee_per_gas: '400000000', gas_limit: 25200 })])
    const { d, sent, kv } = setup(w)
    await putJson(kv, trackKey(1), { hash: txHashOf(oldRaw), status: 'sent', at: NOW_MS - 2 * MIN, prior: [txHashOf(oldRaw)] } satisfies PayoutTrack)
    await run(d)
    expect(sent).toEqual([newRaw])
    expect(await getJson<PayoutTrack>(kv, trackKey(1))).toMatchObject({ hash: txHashOf(newRaw), status: 'sent', prior: [txHashOf(oldRaw)] })
    w.receipts[txHashOf(newRaw)] = { status: '0x1' }
    await run(d)
    expect(await getJson<PayoutTrack>(kv, trackKey(1))).toMatchObject({ hash: txHashOf(newRaw), status: 'mined' })
  })
})

describe('a signing request whose MPC callback was lost is reset', () => {
  it('first sighting only starts the clock; after 10 minutes the tick calls reset_payout_signing {id}', async () => {
    const w = withPayouts([payout(1, { signing: true })])
    const { d, calls, kv } = setup(w, { vance: false })
    await run(d)
    expect(methods(calls)).toEqual([])
    expect(await getJson(kv, 'signing:1')).toBe(NOW_MS)
    w.now = NOW_MS + 9 * MIN
    await run(d)
    expect(methods(calls)).toEqual([])
    w.now = NOW_MS + 11 * MIN
    const log = await run(d)
    const c = calls.find((x) => x.method === 'reset_payout_signing')!
    expect(c).toMatchObject({ who: 'play.titleshot.testnet', args: { id: 1 } })
    expect(log.steps.find((s) => s.action === 'reset_signing#1')).toMatchObject({ ok: true })
    expect(await getJson(kv, 'signing:1')).toBeNull()
  })
  it('a failed reset (E_TOO_EARLY) is logged and retried, the clock is kept', async () => {
    const w = withPayouts([payout(1, { signing: true })])
    w.failures.reset_payout_signing = 'Smart contract panicked: E_TOO_EARLY'
    const { d, kv } = setup(w)
    await putJson(kv, 'signing:1', NOW_MS - 11 * MIN)
    const log = await run(d)
    expect(log.steps.find((s) => s.action === 'reset_signing#1')).toMatchObject({ ok: false, detail: 'E_TOO_EARLY' })
    expect(await getJson(kv, 'signing:1')).toBe(NOW_MS - 11 * MIN)
  })
  it('once signing is over the marker is cleared, so a later re-sign gets a fresh 10 minutes', async () => {
    const w = withPayouts([payout(1, { raw_tx: '0x02f8e1', nonce: 0 })])
    const { d, kv } = setup(w)
    await putJson(kv, 'signing:1', NOW_MS - 30 * MIN)
    await run(d)
    expect(await getJson(kv, 'signing:1')).toBeNull()
  })
  it('a re-sign in flight (signing and a raw tx) is not broadcast or bumped meanwhile', async () => {
    const w = withPayouts([payout(1, { signing: true, raw_tx: '0x02f8e2', nonce: 0 })])
    const { d, sent } = setup(w)
    await run(d)
    expect(sent).toEqual([])
  })
  it('after the reset the payout is signed again on the next tick', async () => {
    const w = withPayouts([payout(1, { signing: true })])
    const { d, calls, kv } = setup(w, { vance: false })
    await putJson(kv, 'signing:1', NOW_MS - 11 * MIN)
    await run(d)
    w.payouts['1:2'] = [payout(1)]
    w.now += 30_000
    await run(d)
    expect(methods(calls)).toEqual(['reset_payout_signing', 'sign_payout'])
  })
})

describe('dust is reported once, not on every tick', () => {
  it('the first tick logs DUST, the following ones stay quiet and make no RPC fee calls', async () => {
    const w = withPayouts([payout(1, { amount_wei: '1000' })])
    const { d, calls } = setup(w, { vance: false })
    const first = await run(d)
    expect(first.steps.filter((s) => s.detail?.startsWith('DUST')).length).toBe(1)
    w.now += 60_000
    const second = await run(d)
    expect(second.steps.filter((s) => s.action === 'sign_payout#1')).toEqual([])
    expect(methods(calls)).not.toContain('sign_payout')
  })
})

describe('the sweep does not drop a failed relay or expiry', () => {
  const forging = (id: number, ageMs: number, over: Partial<RawChallenge> = {}) => challenge({ id, created_at: ns(NOW_MS - ageMs), ...over })
  it('a failed submit_forge keeps the cursor on that challenge and is retried next tick', async () => {
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 2, challenges: { 0: forging(0, 5000, { relayer: true, need_compile: false }), 1: forging(1, 4000, { relayer: true, need_compile: false }) } })
    w.failures.submit_forge = 'Smart contract panicked: E_NOT_FORGING_YET'
    const { d, calls, kv } = setup(w, { relayer: true })
    await run(d)
    expect(calls.filter((c) => c.method === 'submit_forge').map((c) => c.args.challenge_id)).toEqual([0])
    expect(await getJson(kv, 'sweep:cursor')).toBe(0)
    delete w.failures.submit_forge
    w.now += 25_000
    await run(d)
    expect(calls.filter((c) => c.method === 'submit_forge').map((c) => c.args.challenge_id)).toEqual([0, 0, 1])
    expect(await getJson(kv, 'sweep:cursor')).toBe(2)
  })
  it('a compile that throws (NEAR AI down) holds the cursor, logs the failure and moves on after expiry', async () => {
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging(0, 5000, { relayer: true, need_compile: true, sentence: 'a goose with a mortgage' }) } })
    const { d, calls, kv } = setup(w, { relayer: true })
    d.env.NEARAI_API_KEY = 'k'
    const log = await run(d)
    expect(log.steps.find((s) => s.action.startsWith('relay#0'))).toMatchObject({ ok: false })
    expect(await getJson(kv, 'sweep:cursor')).toBe(0)
    w.now += 11 * MIN
    await run(d)
    expect(calls.filter((c) => c.method === 'expire_challenge').map((c) => c.args.id)).toEqual([0])
    expect(await getJson(kv, 'sweep:cursor')).toBe(1)
  })
  it('in relayer mode an old forging challenge is expired instead of relayed', async () => {
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging(0, 11 * MIN, { relayer: true, need_compile: false }) } })
    const { d, calls } = setup(w, { relayer: true })
    await run(d)
    expect(methods(calls)).toEqual(['expire_challenge'])
  })
  it('a failed expiry holds the cursor; the next tick tries again', async () => {
    const w = world({ belts: [], nextChallenge: 1, challenges: { 0: forging(0, 11 * MIN) } })
    w.failures.expire_challenge = 'E_TOO_EARLY'
    const { d, calls, kv } = setup(w)
    await run(d)
    expect(await getJson(kv, 'sweep:cursor')).toBe(0)
    delete w.failures.expire_challenge
    w.now += 25_000
    await run(d)
    expect(calls.filter((c) => c.method === 'expire_challenge').length).toBe(2)
    expect(await getJson(kv, 'sweep:cursor')).toBe(1)
  })
})
