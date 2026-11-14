// Fixes for the 2026-11-14 senior review beyond its own failing tests (review-findings.test.ts): stranger fee clamp,
// Vance as payee, deploy gates, sweep cursor bounds, IPv6 rate-limit buckets, re-entrant guests, pending guest keys.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { belt, CONTRACT, NOW_MS, ns, payout, season } from './fixtures'
import { MemKV, ROOT, TEST_ADDRESS } from './helpers'
import { run, setup, world } from './tick-rig'
import { getJson, putJson, scoped } from '../functions/_lib/cache'
import { txHashOf } from '../functions/_lib/evm'
import { strangerFees } from '../functions/_lib/fees'
import { ipBucket } from '../functions/_lib/http'
import { clampCursor } from '../functions/_lib/tick'
import { trackKey } from '../functions/_lib/tickPayouts'
import { createGuest, guestKey, sessionAllowance } from '../functions/_lib/guest'
import { NEAR } from '../src/game/chain/signer'
import { RpcError } from '../src/game/chain/rpc'
import { NearClient } from '../src/game/near'
import { PENDING_KEY, type KeyStore } from '../src/game/nearKeys'
import type { PayoutTrack } from '../functions/_lib/tickTypes'
import type { RawSeason } from '../src/game/chain/views'

const MIN = 60_000
const closed = (extra: Partial<RawSeason> = {}) => season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1], closes_at: ns(NOW_MS - 10_000), ...extra })

describe('payouts: the contract clamps a stranger to a 1% gas burn, Vance signs its own as the payee', () => {
  it('strangerFees mirrors clamp_stranger_fee (cap / gas, never below 1 wei, tip follows the cap down)', () => {
    expect(strangerFees(10n ** 14n, 25_200n, 300_100_000n, 1_000_000n)).toEqual({ maxFee: 39_682_539n, priority: 1_000_000n })
    expect(strangerFees(10n ** 18n, 25_200n, 300_100_000n, 1_000_000n)).toEqual({ maxFee: 300_100_000n, priority: 1_000_000n })
    expect(strangerFees(50n, 21_000n, 9n, 9n)).toEqual({ maxFee: 1n, priority: 1n })
  })
  it('a fresh stranger signature records the clamped fees, the ones the contract really signed with', async () => {
    const w = world({ belts: [belt({ season: closed() })], payouts: { '1:2': [payout(1, { amount_wei: '100000000000000' })] } })
    const { d, kv, calls } = setup(w)
    await run(d)
    expect(calls.find((c) => c.method === 'sign_payout')).toMatchObject({ who: 'play.titleshot.testnet' })
    expect(await getJson(kv, scoped(CONTRACT, 'payoutfee:1'))).toEqual({ maxFee: '39682539', priority: '1000000' })
  })
  it('a stuck stranger tx already at the 1% cap is not "bumped" to the same fee: STRANGER_CAP, no sign_payout', async () => {
    const raw = '0x02f8c1'
    const w = world({ belts: [belt({ season: closed() })], payouts: { '1:2': [payout(1, { amount_wei: '100000000000000', raw_tx: raw, nonce: 0, max_fee_per_gas: '39682539', gas_limit: 25200 })] } })
    const { d, kv, calls } = setup(w)
    await putJson(kv, trackKey(CONTRACT, 1), { hash: txHashOf(raw), status: 'sent', at: NOW_MS - 11 * MIN } satisfies PayoutTrack)
    const log = await run(d)
    expect(calls.filter((c) => c.method === 'sign_payout')).toEqual([])
    expect(log.steps.find((s) => s.action === 'bump#1')?.detail).toMatch(/^STRANGER_CAP/)
  })
  it('Vance claims its unaddressed payout and signs it itself as the payee, unclamped, in the same tick', async () => {
    const w = world({ belts: [belt({ holder: 'vance.titleshot.testnet', season: closed({ final_holder: 'vance.titleshot.testnet' }) })], payouts: { '1:2': [payout(1, { payee: 'vance.titleshot.testnet', to: null, amount_wei: '100000000000000' })] } })
    const { d, calls } = setup(w)
    await run(d)
    const claim = calls.findIndex((c) => c.method === 'claim_payout')
    const sign = calls.findIndex((c) => c.method === 'sign_payout')
    expect(claim).toBeGreaterThanOrEqual(0)
    expect(sign).toBeGreaterThan(claim)
    expect(calls[sign]).toMatchObject({ who: 'vance.titleshot.testnet', args: { max_fee_per_gas: '301000000' } }) // 3 x base fee + tip, as requested
    expect(String(calls[claim]!.args.addr).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase())
  })
  it('a payout of someone else with no address is left for its payee (no claim on their behalf)', async () => {
    const w = world({ belts: [belt({ season: closed() })], payouts: { '1:2': [payout(1, { to: null })] } })
    const { d, calls } = setup(w)
    await run(d)
    expect(calls.filter((c) => c.method === 'claim_payout' || c.method === 'sign_payout')).toEqual([])
  })
})

describe('deploy gates: no funded seasons on a contract that refuses every challenge', () => {
  it('blocking gates -> NOT_READY logged, no funding, no open_season', async () => {
    const w = world({ autoMine: true, belts: [belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', closes_at: ns(NOW_MS - 120_000) }) })], blockingGates: ['vrf_pubkey'] })
    const { d, calls, sent } = setup(w)
    const log = await run(d)
    expect(sent).toEqual([])
    expect(calls.filter((c) => c.method === 'open_season' || c.method === 'sign')).toEqual([])
    expect(log.steps.find((s) => s.action === 'open')?.detail).toBe('NOT_READY: vrf_pubkey')
  })
  it('Vance without NEAR for the forge fee + gas funds nothing (the purse would sit with no season)', async () => {
    const w = world({ autoMine: true, belts: [belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', closes_at: ns(NOW_MS - 120_000) }) })] })
    const { d, calls, sent } = setup(w)
    ;(d.near as any).balance = async () => 10n ** 21n
    const log = await run(d)
    expect(sent).toEqual([])
    expect(calls.filter((c) => c.method === 'open_season' || c.method === 'sign')).toEqual([])
    expect(log.steps.find((s) => s.action === 'open')?.detail).toMatch(/^VANCE_NEAR_DRY/)
  })
  it('scripts/check-gates.mjs fails production on a blocking gate and staging on anything but forge_mode', () => {
    const gates = (failing: object[], ready: boolean) => `Function execution return value (printed to stdout):\n${JSON.stringify({ ok: !failing.length, ready, failing })}\n`
    const check = (mode: string, out: string) => spawnSync('node', [join(ROOT, 'scripts/check-gates.mjs'), mode], { input: out, encoding: 'utf8' }).status
    const vrf = { gate: 'vrf_pubkey', why: 'no pinned VRF key', blocking: true }
    const relayer = { gate: 'forge_mode', why: 'relayer mode', blocking: false }
    const secrets = { gate: 'forge_secrets', why: 'none', blocking: false }
    expect(check('production', gates([vrf], false))).toBe(1)
    expect(check('production', gates([secrets], true))).toBe(0)
    expect(check('staging', gates([relayer], true))).toBe(0)
    expect(check('staging', gates([relayer, { gate: 'allowlist', why: 'x', blocking: true }], false))).toBe(1)
    expect(check('production', 'error: no such method')).toBe(1)
  })
})

describe('the sweep cursor stays inside [next - 30, next]', () => {
  it('clamps a stale, foreign or missing cursor', () => {
    expect(clampCursor(40, 6)).toBe(6)
    expect(clampCursor(2, 100)).toBe(70)
    expect(clampCursor(null, 100)).toBe(70)
    expect(clampCursor(85, 100)).toBe(85)
    expect(clampCursor(null, 4)).toBe(0)
  })
})

describe('IPv6 clients are limited per /64', () => {
  it('addresses in one /64 share a bucket; IPv4 and mapped IPv4 are unchanged', () => {
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:0db8:0001:0002:ffff:eeee:dddd:cccc')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9')
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(ipBucket('local')).toBe('local')
  })
})

describe('guests: a retry resumes the same account instead of funding a second one', () => {
  function fakes(opts: { depositFails?: number; createTimesOut?: boolean } = {}) {
    const sent: { receiver: string; kinds: string[] }[] = []
    const accounts = new Set<string>()
    let deposits = 0
    let credited = 0n
    let depositFails = opts.depositFails ?? 0
    const near = {
      balance: async (id: string) => { if (id === 'play.titleshot.testnet' || accounts.has(id)) return 20n * NEAR; throw new RpcError('no such account', 'UNKNOWN_ACCOUNT', null) },
      view: async (_c: string, m: string) => { if (m === 'balance_of') return credited.toString(); throw new Error('no view') },
      accessKeyNonce: async () => 1n,
    }
    const sponsor = {
      accountId: 'play.titleshot.testnet',
      send: async (receiver: string, actions: any[]) => {
        sent.push({ receiver, kinds: actions.map((a) => a.kind) })
        if (actions[0].kind === 'createAccount') accounts.add(receiver)
        return `h${sent.length}`
      },
      wait: async (hash: string) => {
        const s = sent[Number(hash.slice(1)) - 1]!
        if (s.kinds[0] === 'createAccount' && opts.createTimesOut) throw new Error('timeout waiting')
        if (s.kinds[0] === 'functionCall') { if (depositFails > 0) { depositFails--; return { failure: 'E_X' } } deposits++; credited += 3n * NEAR / 10n }
        return { failure: null }
      },
    }
    return { near, sponsor, sent, count: () => ({ creates: sent.filter((s) => s.kinds[0] === 'createAccount').length, deposits }) }
  }
  const body = { publicKey: 'ed25519:' + '2'.repeat(43), sessionKey: 'ed25519:' + '3'.repeat(43) }

  it('the session key allowance covers every toll the deposit can pay (0.03 NEAR prepaid gas each, +50%)', () => {
    expect(sessionAllowance(3n * NEAR / 10n, NEAR / 10n)).toBe(27n * NEAR / 100n)
    expect(sessionAllowance(NEAR / 20n, NEAR / 10n)).toBe(NEAR / 10n)
  })
  it('a deposit that failed twice is finished by the retry: one account, one deposit', async () => {
    const f = fakes({ depositFails: 2 })
    const kv = new MemKV()
    const d = { sponsor: f.sponsor as any, near: f.near as any, contract: CONTRACT, floorNear: 1, kv, rand: () => 1 }
    await expect(createGuest(d, body)).rejects.toMatchObject({ code: 'GUEST_DEPOSIT_FAILED' })
    expect(await getJson(kv, guestKey(CONTRACT, body.publicKey))).toMatchObject({ funded: false })
    const again = await createGuest(d, body)
    expect(f.count()).toEqual({ creates: 1, deposits: 1 })
    expect(await createGuest(d, body)).toEqual(again) // funded: nothing is sent
    expect(f.count()).toEqual({ creates: 1, deposits: 1 })
  })
  it('a creation whose wait timed out but landed is kept and funded, not reported as failed', async () => {
    const f = fakes({ createTimesOut: true })
    const r = await createGuest({ sponsor: f.sponsor as any, near: f.near as any, contract: CONTRACT, floorNear: 1, kv: new MemKV(), rand: () => 1 }, body)
    expect(r.accountId).toMatch(/\.play\.titleshot\.testnet$/)
    expect(f.count()).toEqual({ creates: 1, deposits: 1 })
  })
})

describe('the browser keeps a pending guest key until the server answers', () => {
  const memStore = (): KeyStore & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) } }
  it('a failed /api/guest leaves the keys in storage and the retry sends the same public key', async () => {
    const keys: string[] = []
    let fail = true
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/guest')) {
        keys.push(JSON.parse(String(init!.body)).publicKey)
        if (fail) return new Response(JSON.stringify({ error: 'x', code: 'GUEST_DEPOSIT_FAILED' }), { status: 502 })
        return new Response(JSON.stringify({ accountId: 'brave-otter-03.play.titleshot.testnet' }))
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: Array.from(new TextEncoder().encode('"0"')), logs: [] } }))
    }) as unknown as typeof fetch
    const store = memStore()
    const c = new NearClient({ contractId: CONTRACT, fetchFn, store, rpcUrls: ['https://rpc.test'] })
    await expect(c.createGuest()).rejects.toBeTruthy()
    expect(store.m.get(PENDING_KEY)).toBeTruthy()
    fail = false
    expect((await c.createGuest()).id).toBe('brave-otter-03.play.titleshot.testnet')
    expect(keys.length).toBe(2)
    expect(keys[1]).toBe(keys[0])
    expect(store.m.get(PENDING_KEY)).toBeUndefined()
  })
  it('a payout address must be a 0x Base address before anything is signed', async () => {
    const c = new NearClient({ contractId: CONTRACT, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch, store: memStore() })
    await expect(c.claimPayout(1, 'not-an-address')).rejects.toMatchObject({ code: 'E_ADDRESS' })
  })
})
