import { describe, expect, it } from 'vitest'
import { archetypes, env, mpcSign, recordedExchange, sim, TEST_ADDRESS } from './helpers'
import { belt, challenge, FEE, NOW_MS, ns, payout, season, CONTRACT } from './fixtures'
import { run, setup, world, methods, type World } from './tick-rig'
import { needsOpening } from '../functions/_lib/tickOpen'
import { fundPurse, parseMpcSignature, pursePlan } from '../functions/_lib/purse'
import { tidyOpener, openerOk, writeOpener, FALLBACK_OPENERS } from '../functions/_lib/opener'
import { getJson, putJson, scoped } from '../functions/_lib/cache'
import type { RawBelt, RawChallenge } from '../src/game/chain/views'
import { fromHex } from '../src/game/chain/bytes'

describe('payouts of the previous season are finished after the next season opens', () => {
  it('signs and broadcasts the last bell payouts while a new season is open', async () => {
    const prev = season({ id: 1, state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1, 2] })
    const w = world({ belts: [belt({ season: season({ id: 2 }) })], seasons: { '1:1': prev }, payouts: { '1:1': [payout(1), payout(2, { raw_tx: '0x02f8ee', nonce: 0 })] } })
    const { d, calls, sent } = setup(w)
    await run(d)
    expect(calls.filter((c) => c.method === 'sign_payout').map((c) => c.args.payout_id)).toEqual([1])
    expect(sent).toEqual(['0x02f8ee'])
  })
  it('a first season has no previous season to look at', async () => {
    const { d } = setup(world({ belts: [belt({ season: season({ id: 1 }) })] }))
    const log = await run(d)
    expect(log.steps.filter((x) => x.action.startsWith('payouts'))).toEqual([])
  })
})

describe('Vance opens the next season', () => {
  const openW = (over: Partial<World> = {}) => world({ autoMine: true, ...over })
  const closedBelt = (over: Partial<RawBelt> = {}) => belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', closes_at: ns(NOW_MS - 120_000) }), ...over })
  it('waits 60 s after the bell, opens at once when no season exists or the opener aborted', () => {
    expect(needsOpening(belt(), NOW_MS)).toBe(false)
    expect(needsOpening(belt({ season: season({ state: 'Closed', closes_at: ns(NOW_MS - 30_000) }) }), NOW_MS)).toBe(false)
    expect(needsOpening(closedBelt(), NOW_MS)).toBe(true)
    expect(needsOpening(belt({ season: null }), NOW_MS)).toBe(true)
    expect(needsOpening(belt({ season: season({ state: 'Aborted' }) }), NOW_MS)).toBe(true)
    expect(needsOpening(belt({ season: season({ state: 'Opening' }) }), NOW_MS)).toBe(false)
  })
  it('writes an opener, funds the purse through Chain Signatures, opens the season and records the purse address', async () => {
    const { d, calls, sent } = setup(openW({ belts: [closedBelt()] }))
    const log = await run(d)
    expect(methods(calls.filter((c) => c.who.startsWith('vance')))).toEqual(['sign', 'open_season', 'set_purse_address'])
    const sign = calls.find((c) => c.method === 'sign')!
    expect(sign.receiver).toBe('v1.signer-prod.testnet')
    expect(sign.args.request).toMatchObject({ path: 'vance-purse', domain_id: 0 })
    expect(sign.args.request.payload_v2.Ecdsa).toMatch(/^[0-9a-f]{64}$/)
    expect(sign.deposit).toBe(1n)
    expect(sent.length).toBe(0 + 1) // the funding tx was broadcast on Base Sepolia
    expect(fromHex(sent[0]!)[0]).toBe(2) // EIP-1559
    const open = calls.find((c) => c.method === 'open_season')!
    expect(open.args).toMatchObject({ belt_id: 1, duration_sec: 3600 })
    expect(FALLBACK_OPENERS).toContain(open.args.opener_sentence)
    expect(open.args.purse_wei).toBe('2000000000000000')
    expect(open.deposit).toBe(BigInt(FEE))
    const set = calls.find((c) => c.method === 'set_purse_address')!
    expect(set.args).toMatchObject({ belt: 1, season: 3, addr: TEST_ADDRESS })
    expect(set.deposit).toBe(1n)
    expect(log.steps.filter((s) => !s.ok)).toEqual([])
  })
  it('a Vance wallet that cannot cover the purse stops cleanly with VANCE_DRY and the address to fund', async () => {
    const { d, calls } = setup(world({ belts: [closedBelt()], baseBalance: 1000n }))
    const log = await run(d)
    expect(methods(calls)).not.toContain('open_season')
    expect(log.steps.find((s) => s.action === 'fund_purse')).toMatchObject({ ok: false })
    expect(log.steps.find((s) => s.action === 'fund_purse')!.detail).toContain('VANCE_DRY')
    expect(log.steps.find((s) => s.action === 'fund_purse')!.detail).toContain(TEST_ADDRESS)
  })
  it('a smaller balance scales the purse down instead of failing (floor 0.0005 ETH)', async () => {
    const { d, calls } = setup(openW({ belts: [closedBelt()], baseBalance: 1_000_000_000_000_000n }))
    await run(d)
    const open = calls.find((c) => c.method === 'open_season')!
    expect(BigInt(open.args.purse_wei)).toBeLessThan(2_000_000_000_000_000n)
    expect(BigInt(open.args.purse_wei)).toBeGreaterThanOrEqual(500_000_000_000_000n)
  })
  it('a contract refusal of open_season is logged with its code and the purse address is not set', async () => {
    const { d, calls } = setup(openW({ belts: [closedBelt()], failures: { open_season: 'E_SEASON_OPEN' } }))
    const log = await run(d)
    expect(log.steps.find((s) => s.action === 'open_season')).toMatchObject({ ok: false, detail: 'E_SEASON_OPEN' })
    expect(methods(calls)).not.toContain('set_purse_address')
  })
  it('an aborted opener reopens with the next season id; a belt of another promoter is left alone', async () => {
    const { d, calls, kv } = setup(openW({ belts: [belt({ season: season({ id: 4, state: 'Aborted' }) })] }))
    await putJson(kv, scoped(CONTRACT, 'aborts:1'), { seasonId: 4, count: 1, at: NOW_MS - 6 * 60_000 })
    await run(d)
    expect(calls.find((c) => c.method === 'set_purse_address')!.args.season).toBe(5)
    const other = setup(openW({ belts: [closedBelt({ promoter: 'someone-else.testnet' })] }))
    await run(other.d)
    expect(methods(other.calls)).toEqual([])
  })
  it('repeated aborts back off instead of funding a new purse every tick, and pause after four in a row', async () => {
    const abortedW = (over: Partial<World> = {}) => openW({ belts: [belt({ season: season({ id: 4, state: 'Aborted' }) })], ...over })
    // first sighting: the clock starts, nothing is funded or opened
    const a = setup(abortedW())
    const log = await run(a.d)
    expect(log.steps.find((x) => x.action === 'open_backoff')).toMatchObject({ ok: false })
    expect(a.sent).toEqual([])
    expect(methods(a.calls)).toEqual([])
    expect(await getJson(a.kv, scoped(CONTRACT, 'aborts:1'))).toMatchObject({ seasonId: 4, count: 1 })
    // still inside 5 minutes: still waiting, and the count is not bumped again by every tick
    const w = abortedW()
    const b = setup(w)
    await putJson(b.kv, scoped(CONTRACT, 'aborts:1'), { seasonId: 4, count: 1, at: NOW_MS - 4 * 60_000 })
    await run(b.d)
    expect(methods(b.calls)).toEqual([])
    expect(await getJson(b.kv, scoped(CONTRACT, 'aborts:1'))).toMatchObject({ count: 1 })
    // second abort (count 2): 10 minutes
    const c = setup(abortedW())
    await putJson(c.kv, scoped(CONTRACT, 'aborts:1'), { seasonId: 3, count: 1, at: NOW_MS - 3600_000 })
    await run(c.d)
    expect(await getJson(c.kv, scoped(CONTRACT, 'aborts:1'))).toMatchObject({ seasonId: 4, count: 2 })
    expect(methods(c.calls)).toEqual([])
    // the fourth in a row pauses for hours
    const e = setup(abortedW())
    await putJson(e.kv, scoped(CONTRACT, 'aborts:1'), { seasonId: 3, count: 3, at: NOW_MS - 3600_000 })
    const el = await run(e.d)
    expect(methods(e.calls)).toEqual([])
    expect(el.steps.find((x) => x.action === 'open_backoff')!.detail).toMatch(/4 in a row/)
  })
  it('a season that closes normally clears the abort count', async () => {
    const { d, kv } = setup(openW({ belts: [closedBelt()] }))
    await putJson(kv, scoped(CONTRACT, 'aborts:1'), { seasonId: 1, count: 3, at: NOW_MS - 3600_000 })
    await run(d)
    expect(await getJson(kv, scoped(CONTRACT, 'aborts:1'))).toBeNull()
  })
  it('no Vance key: nothing happens', async () => {
    const { d, calls } = setup(world({ belts: [closedBelt()] }), { vance: false })
    await run(d)
    expect(calls).toEqual([])
  })
  it('a funding tx a previous tick already broadcast is awaited, never sent twice', async () => {
    const w = world({ belts: [closedBelt()] })
    const { d, calls, sent, kv } = setup(w)
    await putJson(kv, scoped(CONTRACT, 'fund:1:3'), { hash: '0x' + '77'.repeat(32), purse: '1500000000000000' })
    w.receipts['0x' + '77'.repeat(32)] = { status: '0x1' }
    await run(d)
    expect(sent.length).toBe(0)
    expect(methods(calls)).not.toContain('sign')
    expect(calls.find((c) => c.method === 'open_season')!.args.purse_wei).toBe('1500000000000000')
  })
  it('the funding tx is saved with its raw bytes BEFORE it is broadcast', async () => {
    const { d, sent } = setup(world({ belts: [closedBelt()], autoMine: true }))
    let atSave: { sent: number; hasRaw: boolean } | null = null
    const r = await fundPurse({ near: d.near, base: d.base, vance: d.vance!, mpc: d.mpc }, '0x' + 'cd'.repeat(20), 2_000_000_000_000_000n, null, async (sv) => { atSave = { sent: sent.length, hasRaw: /^0x02/.test(sv.raw ?? '') } })
    expect(r.ok).toBe(true)
    expect(atSave).toEqual({ sent: 0, hasRaw: true })
    expect(sent.length).toBe(1)
  })
  it('a tick killed after saving but before broadcasting re-sends the identical tx (no second funding, no stall)', async () => {
    const w = world({ belts: [closedBelt()], autoMine: true })
    const first = setup(w)
    let saved: { hash: string; purse: string; raw?: string } | null = null
    // run 1 dies right after the save: nothing reached Base
    await expect(fundPurse({ near: first.d.near, base: { ...first.d.base, call: async (m: string, p: any[]) => { if (m === 'eth_sendRawTransaction') throw new Error('killed'); return (first.d.base as any).call(m, p) } } as any, vance: first.d.vance!, mpc: first.d.mpc }, '0x' + 'cd'.repeat(20), 2_000_000_000_000_000n, null, async (sv) => { saved = sv })).rejects.toThrow('killed')
    expect(first.sent).toEqual([])
    expect(saved!.raw).toMatch(/^0x02/)
    // run 2 (a later tick) finds the saved funding: it broadcasts the same raw once and waits for it
    const second = setup(w)
    const r = await fundPurse({ near: second.d.near, base: second.d.base, vance: second.d.vance!, mpc: second.d.mpc }, '0x' + 'cd'.repeat(20), 2_000_000_000_000_000n, saved)
    expect(r).toMatchObject({ ok: true, txHash: saved!.hash, purseWei: saved!.purse })
    expect(second.sent).toEqual([saved!.raw])
    expect(methods(second.calls)).not.toContain('sign')
  })
  it('a missing purse address on a live season is repaired by the promoter', async () => {
    const { d, calls } = setup(world({ belts: [belt({ season: season({ purse: { chain_id: 84532, path: 'belt-1-s2', amount_wei: '1', address: null, next_nonce: 0 } }) })] }))
    await run(d)
    expect(calls.find((c) => c.method === 'set_purse_address')!.args).toMatchObject({ belt: 1, season: 2, addr: TEST_ADDRESS })
  })
  it('the signer response parser rejects anything that is not a secp256k1 signature', () => {
    expect(() => parseMpcSignature(null)).toThrow()
    expect(() => parseMpcSignature({ big_r: { affine_point: '02' + 'a'.repeat(64) }, s: { scalar: 'b'.repeat(64) }, recovery_id: 2 })).toThrow()
    expect(() => parseMpcSignature({ big_r: { affine_point: 'short' }, s: { scalar: 'b'.repeat(64) }, recovery_id: 0 })).toThrow()
    expect(parseMpcSignature({ big_r: { affine_point: '03' + 'a'.repeat(64) }, s: { scalar: 'b'.repeat(64) }, recovery_id: 1 })).toEqual({ r: '0x' + 'a'.repeat(64), s: '0x' + 'b'.repeat(64), yParity: 1 })
  })
  it('purse planning: full amount when affordable, scaled down to what is left after gas, refused below the floor', () => {
    expect(pursePlan(10n ** 18n, 2n * 10n ** 15n, 10n ** 9n)).toEqual({ purse: 2n * 10n ** 15n, ok: true })
    const scaled = pursePlan(10n ** 15n, 2n * 10n ** 15n, 10n ** 9n)
    expect(scaled.purse).toBe(10n ** 15n - 21_000n * 10n ** 9n)
    expect(scaled.ok).toBe(true)
    expect(pursePlan(10n ** 14n, 2n * 10n ** 15n, 10n ** 9n).ok).toBe(false)
    expect(pursePlan(0n, 1n, 1n)).toEqual({ purse: 0n, ok: false })
  })
  it('fundPurse refuses a signature that does not recover to the Vance address', async () => {
    const { d } = setup(world())
    ;(d.vance as any).wait = async () => ({ failure: null, value: { ...mpcSign('11'.repeat(32)) }, logs: [], events: [], status: 'x', raw: {} })
    const r = await fundPurse({ near: d.near, base: d.base, vance: d.vance!, mpc: d.mpc }, '0x' + 'cd'.repeat(20), 2_000_000_000_000_000n)
    expect(r).toMatchObject({ ok: false, code: 'SIG_MISMATCH' })
  })
})

describe('opener sentences', () => {
  it('tidies model chatter into a sentence the contract accepts', () => {
    expect(tidyOpener('"a retired circus bear with a law degree."\nLet me know!')).toBe('a retired circus bear with a law degree')
    expect(tidyOpener('1. a ghost who is bad at haunting')).toBe('a ghost who is bad at haunting')
    expect(openerOk('a retired circus bear with a law degree')).toBe(true)
    expect(openerOk('hi')).toBe(false)
    expect(openerOk('x '.repeat(80))).toBe(false)
    expect(openerOk('bad\u0007control chars in here')).toBe(false)
  })
  it('falls back to the curated list without a key, on junk, and never repeats a recent one', async () => {
    const a = await writeOpener(env(), 'm', { seasonId: 1, recent: [] })
    expect(a.source).toBe('fallback')
    const b = await writeOpener(env(), 'm', { seasonId: 1, recent: [a.sentence] })
    expect(b.sentence).not.toBe(a.sentence)
    const junkFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))) as unknown as typeof fetch
    expect((await writeOpener(env({ NEARAI_API_KEY: 'k' }), 'm', { seasonId: 2, recent: [] }, junkFetch)).source).toBe('fallback')
  })
  it('uses the NEAR AI sentence when it is good', async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'a lighthouse that moonlights as a DJ' } }] }))) as unknown as typeof fetch
    expect(await writeOpener(env({ NEARAI_API_KEY: 'k' }), 'm', { seasonId: 2, recent: [] }, f)).toEqual({ sentence: 'a lighthouse that moonlights as a DJ', source: 'nearai' })
    const dup = await writeOpener(env({ NEARAI_API_KEY: 'k' }), 'm', { seasonId: 2, recent: ['A lighthouse that moonlights as a DJ'] }, f)
    expect(dup.source).toBe('fallback')
  })
})

describe('the challenge sweep: expiry and the relayer fallback', () => {
  const forging = (id: number, ageMs: number, over: Partial<RawChallenge> = {}) => challenge({ id, created_at: ns(NOW_MS - ageMs), ...over })
  it('a challenge forging for over 10 minutes is expired (refund), a young one is left and not skipped', async () => {
    const w = world({ belts: [], nextChallenge: 3, challenges: { 0: challenge({ id: 0, status: 'Resolved', fight_id: 1 }), 1: forging(1, 11 * 60_000), 2: forging(2, 30_000) } })
    const { d, calls, kv } = setup(w)
    await run(d)
    expect(calls.filter((c) => c.method === 'expire_challenge').map((c) => c.args.id)).toEqual([1])
    expect(await getJson(kv, scoped(CONTRACT, 'sweep:cursor'))).toBe(2)
  })
  it('in relayer mode the relayer delivers the signed NEAR AI compile via submit_forge', async () => {
    const ex = recordedExchange(sim(), 'Qwen/Qwen3.8-27B', 'a pigeon with a law degree', JSON.stringify(archetypes()[0]!.raw))
    const fetchFn = (async (url: string) => {
      if (url.includes('/chat/completions')) return new Response(ex.response)
      return new Response(JSON.stringify({ text: ex.text, signature: ex.signature, signing_address: ex.signing_address, signing_algo: 'ecdsa', signature_kind: 'provider_tee' }))
    }) as unknown as typeof fetch
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging(0, 5000, { relayer: true, sentence: 'a pigeon with a law degree' }) } })
    const { d, calls } = setup(w, { relayer: true, fetchFn })
    d.env.NEARAI_API_KEY = 'k'
    await run(d)
    const sub = calls.find((c) => c.method === 'submit_forge')!
    expect(sub.who).toBe('relay.titleshot.testnet')
    const out = JSON.parse(sub.args.output_json)
    expect(sub.args.challenge_id).toBe(0)
    expect(out).toMatchObject({ ok: true, response: ex.response, signature: ex.signature, signing_algo: 'ecdsa', signature_kind: 'provider_tee', text: ex.text })
  })
  it('a cached sentence (need_compile=false) is relayed without calling NEAR AI', async () => {
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging(0, 5000, { relayer: true, need_compile: false }) } })
    const { d, calls } = setup(w, { relayer: true })
    await run(d)
    expect(JSON.parse(calls.find((c) => c.method === 'submit_forge')!.args.output_json)).toEqual({ ok: true })
  })
  it('no relayer key or outlayer mode: nothing is submitted', async () => {
    const a = setup(world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging(0, 5000, { relayer: true }) } }))
    await run(a.d)
    expect(methods(a.calls)).not.toContain('submit_forge')
    const b = setup(world({ belts: [], nextChallenge: 1, challenges: { 0: forging(0, 5000, { relayer: true }) } }), { relayer: true })
    await run(b.d)
    expect(methods(b.calls)).not.toContain('submit_forge')
  })
})
