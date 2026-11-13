// Guest accounts end to end: economics from env vars, the atomic BUSY guard, and the browser's single-flight createGuest.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ctx, env, json } from './helpers'
import { onRequest as guestApi } from '../functions/api/guest'
import { economicsOf, floorOf, parseNear } from '../functions/_lib/guest'
import { admit } from '../functions/_lib/lane'
import { GUEST_DEPOSIT, GUEST_FUND_GAS } from '../src/game/chain/config'
import { formatPublicKey, formatSecretKey, generateKeyPair } from '../src/game/chain/keys'
import { NearClient } from '../src/game/near'
import { exportKey, loadStored, saveStored, newGuestKeys, type KeyStore } from '../src/game/nearKeys'
import { utf8 } from '../src/game/chain/bytes'

const NEAR = 10n ** 24n
const pub = () => formatPublicKey(generateKeyPair().publicKey)

describe('guest economics are env vars with safe defaults', () => {
  it('defaults: 0.3 NEAR deposit, 0.1 NEAR gas, 0.8 NEAR sponsor floor', () => {
    expect(GUEST_DEPOSIT).toBe(3n * NEAR / 10n)
    expect(GUEST_FUND_GAS).toBe(NEAR / 10n)
    expect(economicsOf(env())).toEqual({ deposit: 3n * NEAR / 10n, gas: NEAR / 10n, floorNear: 0.8 })
  })
  it('GUEST_DEPOSIT_NEAR, GUEST_GAS_NEAR and SPONSOR_FLOOR_NEAR override them', () => {
    const e = env({ GUEST_DEPOSIT_NEAR: '0.25', GUEST_GAS_NEAR: '0.05', SPONSOR_FLOOR_NEAR: '2' })
    expect(economicsOf(e)).toEqual({ deposit: 25n * NEAR / 100n, gas: 5n * NEAR / 100n, floorNear: 2 })
  })
  it('junk, zero, negative, exponent and absurd values fall back to the default (a typo cannot drain the sponsor)', () => {
    for (const bad of ['', 'abc', '0', '0.0', '-1', '1e3', '0x10', '11', '100', '1.5.2', ' ', '0.1234567890123456789012345']) expect(parseNear(bad, 7n), bad).toBe(7n)
    expect(parseNear(undefined, 7n)).toBe(7n)
    expect(parseNear(' 0.3 ', 7n)).toBe(3n * NEAR / 10n)
    expect(parseNear('10', 7n)).toBe(10n * NEAR)
    expect(parseNear('0.000000000000000000000001', 7n)).toBe(1n)
    expect(floorOf('junk')).toBe(0.8)
  })
})

describe('POST /api/guest BUSY guard is atomic', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('admit() takes a slot synchronously: of N simultaneous callers exactly `max` pass, and release frees one (once)', () => {
    const got = Array.from({ length: 10 }, () => admit('t-slot', 3))
    expect(got.filter(Boolean).length).toBe(3)
    got[0]!(); got[0]!() // releasing twice frees one slot, not two
    expect(admit('t-slot', 3)).not.toBeNull()
    expect(admit('t-slot', 3)).toBeNull()
    for (const r of got) r?.()
  })

  it('8 simultaneous requests with 3 slots: 5 are refused with 429 BUSY before any of them finishes; the slots come back afterwards', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', async () => { await gate; return new Response('down', { status: 500 }) }) // every RPC call hangs, then fails
    const e = env({ CONTRACT_ID: 'titleshot.testnet', SPONSOR_KEY: formatSecretKey(generateKeyPair()) })
    const fire = () => guestApi(ctx(json('/api/guest', { publicKey: pub(), sessionKey: pub() }, { headers: { 'cf-connecting-ip': '9.9.9.9' } }), e))
    const marked = Array.from({ length: 8 }, (_, i) => fire().then((r) => ({ i, r })))
    const early: { i: number; r: Response }[] = []
    // everything that answers while the RPC is still hung was refused by the guard
    await Promise.race([Promise.all(marked.map((p) => p.then((x) => early.push(x)))), new Promise((r) => setTimeout(r, 150))])
    const refused = [...early] // the others are still waiting on the RPC
    expect(refused.length).toBe(5)
    for (const { r } of refused) {
      expect(r.status).toBe(429)
      expect(await r.json()).toMatchObject({ code: 'BUSY' })
      expect(r.headers.get('retry-after')).toBe('5')
    }
    release()
    const rest = (await Promise.all(marked)).filter((x) => !refused.includes(x))
    expect(rest.length).toBe(3)
    for (const { r } of rest) expect((await r.json() as { code: string }).code).not.toBe('BUSY')
    // all three slots were released (also on failure): a new request is admitted
    const after = await fire()
    expect((await after.json() as { code: string }).code).not.toBe('BUSY')
  })

  it('a rejected request (bad body) does not keep a slot', async () => {
    const e = env({ CONTRACT_ID: 'titleshot.testnet', SPONSOR_KEY: formatSecretKey(generateKeyPair()) })
    for (let i = 0; i < 10; i++) {
      const r = await guestApi(ctx(json('/api/guest', { publicKey: 'nope' }), e))
      expect(r.status).toBe(400)
    }
    expect(admit('sponsor-guest', 3)).not.toBeNull()
    for (let i = 0; i < 2; i++) admit('sponsor-guest', 3)
  })
})

class MemStore implements KeyStore {
  m = new Map<string, string>()
  get(k: string) { return this.m.get(k) ?? null }
  set(k: string, v: string) { this.m.set(k, v) }
  remove(k: string) { this.m.delete(k) }
}

describe('NearClient.createGuest is single-flight and never overwrites a stored account', () => {
  const CONTRACT = 'titleshot.testnet'
  function client(store: KeyStore, onGuest: () => Promise<Response>) {
    const calls: unknown[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.includes('/api/guest')) { calls.push(JSON.parse(String(init!.body))); return onGuest() }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: Array.from(utf8('"0"')), logs: [] } })) // balance_of -> "0"
    }) as unknown as typeof fetch
    return { c: new NearClient({ contractId: CONTRACT, fetchFn, store, sleep: async () => undefined }), calls }
  }
  const ok = (accountId: string) => new Response(JSON.stringify({ accountId }))

  it('two concurrent calls make one request, return the same account and store one key pair', async () => {
    const store = new MemStore()
    let n = 0
    const { c, calls } = client(store, async () => { await new Promise((r) => setTimeout(r, 20)); return ok(`brave-otter-0${++n}.play.titleshot.testnet`) })
    const [a, b] = await Promise.all([c.createGuest(), c.createGuest()])
    expect(calls.length).toBe(1)
    expect(a).toEqual(b)
    expect(a.id).toBe('brave-otter-01.play.titleshot.testnet')
    expect(loadStored(store)!.accountId).toBe(a.id)
  })
  it('five concurrent calls plus a late one after it settled: still one request in total', async () => {
    const store = new MemStore()
    const { c, calls } = client(store, async () => ok('brave-otter-02.play.titleshot.testnet'))
    const all = await Promise.all(Array.from({ length: 5 }, () => c.createGuest()))
    expect(new Set(all.map((x) => x.id)).size).toBe(1)
    await c.createGuest()
    expect(calls.length).toBe(1)
  })
  it('a failure is shared by the concurrent callers, releases the flight, and the next call retries', async () => {
    const store = new MemStore()
    let n = 0
    const { c, calls } = client(store, async () => (++n === 1 ? new Response(JSON.stringify({ code: 'SPONSOR_DRY', error: 'dry' }), { status: 503 }) : ok('brave-otter-03.play.titleshot.testnet')))
    const first = await Promise.allSettled([c.createGuest(), c.createGuest()])
    expect(first.map((x) => x.status)).toEqual(['rejected', 'rejected'])
    expect(calls.length).toBe(1)
    expect((await c.createGuest()).id).toBe('brave-otter-03.play.titleshot.testnet')
    expect(calls.length).toBe(2)
  })
  it('keys another tab stored while the request was in flight are never overwritten; the new guest goes to the archive', async () => {
    const store = new MemStore()
    const other = newGuestKeys()
    const { c } = client(store, async () => {
      saveStored(store, other, 'funded-ferret-77.play.titleshot.testnet') // the other tab finishes first
      return ok('late-lemur-12.play.titleshot.testnet')
    })
    const acct = await c.createGuest()
    expect(acct.id).toBe('funded-ferret-77.play.titleshot.testnet')
    expect(loadStored(store)!.accountId).toBe('funded-ferret-77.play.titleshot.testnet')
    expect(exportKey(store)!.privateKey).toBe(formatSecretKey(other.full))
    const archive = JSON.parse(store.get('ts-account-archive')!) as { accountId: string; fullKey: string }[]
    expect(archive.map((a) => a.accountId)).toEqual(['late-lemur-12.play.titleshot.testnet']) // recoverable, not lost
    expect(archive[0]!.fullKey.startsWith('ed25519:')).toBe(true)
  })
  it('an account stored before the call is returned without any request', async () => {
    const store = new MemStore()
    saveStored(store, newGuestKeys(), 'old-owl-05.play.titleshot.testnet')
    const { c, calls } = client(store, async () => ok('x.play.titleshot.testnet'))
    expect((await c.createGuest()).id).toBe('old-owl-05.play.titleshot.testnet')
    expect(calls.length).toBe(0)
  })
})

