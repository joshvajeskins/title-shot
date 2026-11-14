import { describe, expect, it } from 'vitest'
import { decodeSignedTransaction } from '@near-js/transactions'
import { env, MemKV, scriptedRpc, sim, TEST_ADDRESS, TEST_DERIVED_KEY } from './helpers'
import { belt, CONTRACT, fighter, fightRow, payout, season, NOW_MS, ns, TOLL } from './fixtures'
import { createGuest, floorOf, guestBody, guestName } from '../functions/_lib/guest'
import { buildState } from '../functions/_lib/state'
import { clearFighterCache } from '../functions/_lib/chain'
import { clearMemoryCache, putJson, scoped } from '../functions/_lib/cache'
import { trackKey } from '../functions/_lib/tickPayouts'
import { Rpc } from '../src/game/chain/rpc'
import { Signer } from '../src/game/chain/signer'
import { formatPublicKey, generateKeyPair, parsePublicKey } from '../src/game/chain/keys'
import { equalBytes, fromB64, utf8 } from '../src/game/chain/bytes'
import { sha256Hex } from '../src/game/chain/signature'
import { ring } from '../../worker-bell/src/index'
import worker from '../../worker-bell/src/index'
import { wantsMock } from '../src/game/factory'
import { browserStore, loadStored, newGuestKeys, saveStored } from '../src/game/nearKeys'

const NEAR = 10n ** 24n
const SPONSOR = 'play.titleshot.testnet'
const ok = { status: { SuccessValue: '' }, transaction_outcome: {}, receipts_outcome: [] }

describe('guest accounts', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => guestName(SPONSOR, (max) => (i * 7 + 3) % max))
  it('names are valid NEAR sub-accounts of the sponsor', () => {
    for (const n of names(200)) { expect(n).toMatch(/^[a-z]+-[a-z]+-\d\d\.play\.titleshot\.testnet$/); expect(n.length).toBeLessThanOrEqual(64) }
  })
  it('body validation needs two different valid ed25519 public keys and nothing else', () => {
    const a = formatPublicKey(generateKeyPair().publicKey), b = formatPublicKey(generateKeyPair().publicKey)
    expect(guestBody.safeParse({ publicKey: a, sessionKey: b }).success).toBe(true)
    for (const bad of [{ publicKey: a, sessionKey: a }, { publicKey: a }, { publicKey: a, sessionKey: b, x: 1 }, { publicKey: 'ed25519:short', sessionKey: b }, { publicKey: 5, sessionKey: b }, { publicKey: a, sessionKey: 'secp256k1:' + b.slice(8) }]) expect(guestBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
  it('the floor defaults to 0.8 NEAR and ignores junk', () => { expect(floorOf(undefined)).toBe(0.8); expect(floorOf('nope')).toBe(0.8); expect(floorOf('-1')).toBe(0.8); expect(floorOf('0.5')).toBe(0.5) })

  function sponsorRig(opts: { balance?: bigint; taken?: boolean; failTx?: number[] } = {}) {
    const sent: string[] = []
    const failTx = new Set(opts.failTx ?? [])
    const script = {
      views: {},
      accounts: { [SPONSOR]: opts.balance ?? 20n * NEAR } as Record<string, bigint>,
      txs: (hash: string) => (failTx.has(sent.findIndex((_, i) => i >= 0 && hash === `h${i}`)) ? undefined : ok),
      onSend: (b64: string) => { sent.push(b64) },
    }
    const rpcFake = scriptedRpc(script)
    const wrapped = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (opts.taken && body.method === 'query' && body.params.request_type === 'view_account' && body.params.account_id !== SPONSOR) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { amount: '1' } }))
      }
      if (body.method === 'tx' && opts.failTx?.length) {
        const idx = sent.length - 1
        if (failTx.has(idx)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: { Failure: { ActionError: { kind: 'x' } } }, receipts_outcome: [] } }))
      }
      return rpcFake.fetchFn(url, init)
    }) as unknown as typeof fetch
    const near = new Rpc({ fetchFn: wrapped })
    const sponsor = new Signer(SPONSOR, generateKeyPair(), near)
    return { near, sponsor, sent, script }
  }
  const body = () => ({ publicKey: formatPublicKey(generateKeyPair().publicKey), sessionKey: formatPublicKey(generateKeyPair().publicKey) })

  it('creates the account with a full-access key and a challenge-only session key, then credits 0.3 NEAR via deposit_for', async () => {
    const { near, sponsor, sent } = sponsorRig()
    const b = body()
    const { accountId } = await createGuest({ sponsor, near, contract: CONTRACT, floorNear: 3, rand: (m) => 1 % m }, b)
    expect(accountId).toMatch(/\.play\.titleshot\.testnet$/)
    expect(sent.length).toBe(2)
    const create = decodeSignedTransaction(fromB64(sent[0]!))
    expect(create.transaction.signerId).toBe(SPONSOR)
    expect(create.transaction.receiverId).toBe(accountId)
    const acts = create.transaction.actions
    expect(acts.length).toBe(4)
    expect(acts[0]!.createAccount).toBeDefined()
    expect(acts[1]!.transfer!.deposit).toBe(100_000_000_000_000_000_000_000n)
    expect(acts[2]!.addKey!.accessKey.permission.fullAccess).toBeDefined()
    const fc = acts[3]!.addKey!.accessKey.permission.functionCall!
    expect(fc.receiverId).toBe(CONTRACT)
    expect(fc.methodNames).toEqual(['challenge'])
    expect(fc.allowance).toBe(270_000_000_000_000_000_000_000n) // 6 tolls of 0.05 x 0.03 NEAR prepaid gas x 1.5: the allowance never gets unused gas back
    const keyBytes = (a: number) => Uint8Array.from((acts[a]!.addKey!.publicKey as any).ed25519Key.data as ArrayLike<number>)
    expect(equalBytes(keyBytes(2), parsePublicKey(b.publicKey))).toBe(true)
    expect(equalBytes(keyBytes(3), parsePublicKey(b.sessionKey))).toBe(true)
    const dep = decodeSignedTransaction(fromB64(sent[1]!))
    expect(dep.transaction.receiverId).toBe(CONTRACT)
    const call = dep.transaction.actions[0]!.functionCall!
    expect(call.methodName).toBe('deposit_for')
    expect(call.deposit).toBe(300_000_000_000_000_000_000_000n)
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>)))).toEqual({ account: accountId })
  })
  it('a sponsor below the floor is 503 SPONSOR_DRY and nothing is sent', async () => {
    const { near, sponsor, sent } = sponsorRig({ balance: 2n * NEAR })
    await expect(createGuest({ sponsor, near, contract: CONTRACT, floorNear: 3 }, body())).rejects.toMatchObject({ status: 503, code: 'SPONSOR_DRY' })
    expect(sent.length).toBe(0)
  })
  it('every candidate name taken is 503 NAME_COLLISION', async () => {
    const { near, sponsor, sent } = sponsorRig({ taken: true })
    await expect(createGuest({ sponsor, near, contract: CONTRACT, floorNear: 3 }, body())).rejects.toMatchObject({ code: 'NAME_COLLISION' })
    expect(sent.length).toBe(0)
  })
  it('a failed creation is GUEST_CREATE_FAILED; a failed funding (twice) is GUEST_DEPOSIT_FAILED', async () => {
    const a = sponsorRig({ failTx: [0] })
    await expect(createGuest({ sponsor: a.sponsor, near: a.near, contract: CONTRACT, floorNear: 3 }, body())).rejects.toMatchObject({ status: 502, code: 'GUEST_CREATE_FAILED' })
    const c = sponsorRig({ failTx: [1, 2] })
    await expect(createGuest({ sponsor: c.sponsor, near: c.near, contract: CONTRACT, floorNear: 3 }, body())).rejects.toMatchObject({ status: 502, code: 'GUEST_DEPOSIT_FAILED' })
    expect(c.sent.length).toBe(3)
  })
})

describe('title-shot-bell cron Worker', () => {
  const e = { PAGES_URL: 'https://title-shot.pages.dev/', TICK_SECRET: 'tok' }
  const resp = (status: number, body = '{}') => new Response(body, { status })
  it('POSTs /api/tick with the token header (no double slash)', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const r = await ring(e, (async (url: string, init: RequestInit) => { seen.push({ url, init }); return resp(200, '{"steps":[]}') }) as unknown as typeof fetch)
    expect(r.ok).toBe(true)
    expect(seen[0]!.url).toBe('https://title-shot.pages.dev/api/tick')
    expect(seen[0]!.init.method).toBe('POST')
    expect((seen[0]!.init.headers as Record<string, string>)['x-tick-secret']).toBe('tok')
  })
  it('retries once on a 5xx or a network error, never on a 4xx', async () => {
    let n = 0
    const flaky = (async () => (++n === 1 ? resp(502) : resp(200))) as unknown as typeof fetch
    expect((await ring(e, flaky)).ok).toBe(true)
    expect(n).toBe(2)
    let m = 0
    expect((await ring(e, (async () => { m++; return resp(401) }) as unknown as typeof fetch)).status).toBe(401)
    expect(m).toBe(1)
    let k = 0
    const net = (async () => { k++; throw new Error('offline') }) as unknown as typeof fetch
    const r = await ring(e, net)
    expect(r).toMatchObject({ ok: false, status: 0 })
    expect(k).toBe(2)
  }, 10000)
  it('the scheduled handler rings through waitUntil and the fetch handler is a health stub', async () => {
    const pending: Promise<unknown>[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => resp(200)) as unknown as typeof fetch
    try {
      await worker.scheduled({ scheduledTime: 1 }, e, { waitUntil: (p) => { pending.push(p) } })
      await Promise.all(pending)
    } finally { globalThis.fetch = realFetch }
    expect(pending.length).toBe(1)
    expect(await (await worker.fetch(new Request('https://x.test/'), e)).json()).toMatchObject({ name: 'title-shot-bell' })
  })
})

describe('client selection and key storage', () => {
  const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k) } }
  it('mock is chosen by ?mock=1, VITE_MODE=mock or a missing contract id, and ?mock=0 undoes a stored choice', () => {
    expect(wantsMock('', undefined, 'titleshot.testnet', mem())).toBe(false)
    expect(wantsMock('?mock=1', undefined, 'titleshot.testnet', mem())).toBe(true)
    expect(wantsMock('', 'mock', 'titleshot.testnet', mem())).toBe(true)
    expect(wantsMock('', undefined, undefined, mem())).toBe(true)
    const s = mem()
    expect(wantsMock('?mock=1', undefined, 'c', s)).toBe(true)
    expect(wantsMock('', undefined, 'c', s)).toBe(true) // remembered for the tab session
    expect(wantsMock('?mock=0', undefined, 'c', s)).toBe(false)
    expect(wantsMock('', undefined, 'c', s)).toBe(false)
    expect(wantsMock('?mock=0', undefined, undefined, mem())).toBe(true) // no contract id: still mock
  })
  it('stored accounts survive a round trip; corrupt or foreign data is ignored', () => {
    const s = mem()
    const keys = newGuestKeys()
    saveStored(s, keys, 'a.play.titleshot.testnet')
    expect(loadStored(s)).toMatchObject({ accountId: 'a.play.titleshot.testnet' })
    s.set('ts-account', '{"accountId": 5}')
    expect(loadStored(s)).toBeNull()
    s.set('ts-account', 'not json')
    expect(loadStored(s)).toBeNull()
    s.set('ts-account', JSON.stringify({ accountId: 'x', fullKey: 'nope', sessionKey: 'nope' }))
    expect(loadStored(s)).toBeNull()
  })
  it('blocked storage falls back to memory instead of throwing', () => {
    const s = browserStore() // node: no localStorage
    s.set('k', 'v')
    expect(s.get('k')).toBe('v')
    s.remove('k')
    expect(s.get('k')).toBeNull()
  })
})

/** get_config as contract/src/views.rs emits it: no rulebook hash, only the sha256 of the stored request prefix and suffix. */
const configRaw = (over: Record<string, unknown> = {}) => {
  const p = sim().requestParts('Qwen/Qwen3.8-27B')
  return { forge_mode: 'outlayer', model_id: 'Qwen/Qwen3.8-27B', signature_kind: 'provider_tee', prefix_sha256: sha256Hex(utf8(p.prefix)), suffix_sha256: sha256Hex(utf8(p.suffix)), ...over }
}

describe('GET /api/state builds the whole lobby from the contract', () => {
  function rig() {
    clearMemoryCache(); clearFighterCache()
    const kv = new MemKV()
    const prevClosed = season({ id: 1, state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [7, 8], closes_at: ns(NOW_MS - 90_000_000), defence_count: [{ account: 'otto-ink.testnet', defences: 2 }] })
    const cur = season({ id: 2 })
    const A = fighter(0), B = fighter(1, 'mara-quill.testnet')
    const fights = [fightRow(2, 0, 1, { at: ns(NOW_MS - 1000) }), fightRow(1, 1, 0, { at: ns(NOW_MS - 60_000) })]
    const calls: string[] = []
    const script = {
      views: {
        [`${CONTRACT}:get_config`]: () => configRaw(),
        [`${CONTRACT}:get_belts`]: () => [belt({ season: cur }), belt({ id: 2, name: 'The Tide Belt', champion: null, season: null })],
        [`${CONTRACT}:get_fights`]: (a: { belt_id: number }) => (a.belt_id === 1 ? fights : []),
        [`${CONTRACT}:get_fighter`]: (a: { hash_hex: string }) => [A, B].find((f) => f.hash === a.hash_hex) ?? null,
        [`${CONTRACT}:get_season`]: () => prevClosed,
        [`${CONTRACT}:get_payouts`]: () => [payout(7), payout(8, { payee: 'mara-quill.testnet', raw_tx: '0x02aa', nonce: 0 })],
        'v1.signer-prod.testnet:derived_public_key': () => TEST_DERIVED_KEY,
      } as Record<string, (a: any) => unknown>,
      accounts: { 'play.titleshot.testnet': 7n * NEAR, 'vance.titleshot.testnet': 3n * NEAR, 'relay.titleshot.testnet': NEAR / 2n } as Record<string, bigint>,
    }
    const { fetchFn } = scriptedRpc(script)
    const near = new Rpc({ fetchFn: ((u: string, i: RequestInit) => { calls.push(JSON.parse(String(i.body)).params?.method_name ?? ''); return fetchFn(u, i) }) as unknown as typeof fetch })
    const base = { call: async (m: string) => (m === 'eth_getBalance' ? '0x2386f26fc10000' : '0x0') } as unknown as Rpc
    const e = env({ CONTRACT_ID: CONTRACT })
    e.TS_KV = kv
    return { e, near, base, kv, calls }
  }
  it('maps belts (hiding a belt with no champion), fights with names, wallets and the last bell', async () => {
    const { e, near, base, kv } = rig()
    await putJson(kv, trackKey(CONTRACT, 8), { hash: '0xfeed', status: 'mined', at: NOW_MS })
    await putJson(kv, scoped(CONTRACT, 'tick:last'), { at: NOW_MS, ms: 5, steps: [] })
    const s = await buildState(e, sim(), near, base, NOW_MS)
    expect(s.contract).toBe(CONTRACT)
    expect(s.forgeMode).toBe('outlayer')
    expect(s.rulebookMatch).toBe(true)
    expect(s.belts.map((b) => b.name)).toEqual(['The Midnight Belt'])
    expect(s.fights.length).toBe(2)
    expect(s.fights[0]).toMatchObject({ beltId: '1', championName: 'Counselor Coo', challengerName: 'Granny Purl', tollYocto: TOLL })
    expect(s.wallets.map((w) => [w.role, w.account])).toEqual([['sponsor', 'play.titleshot.testnet'], ['promoter', 'vance.titleshot.testnet'], ['relayer', 'relay.titleshot.testnet']])
    const vance = s.wallets.find((w) => w.role === 'promoter')!
    expect(vance.baseAddress).toBe(TEST_ADDRESS)
    expect(vance.baseWei).toBe('10000000000000000')
    expect(s.wallets[0]!.nearYocto).toBe((7n * NEAR).toString())
    const bell = s.belts[0]!.lastBell!
    expect(bell.seasonId).toBe(1)
    expect(bell.payouts.map((p) => p.status)).toEqual(['unsigned', 'mined'])
    expect(bell.payouts[1]!.explorer).toContain('0xfeed')
    expect(s.tick).toMatchObject({ at: NOW_MS })
    expect(s.payouts).toEqual([]) // the current season is open: nothing to pay yet
  })
  it('compiler says which referee compiles: nearai by default, standin only without a NEAR AI key and with COMPILER_MODE=standin', async () => {
    const { e, near, base } = rig()
    expect((await buildState(e, sim(), near, base, NOW_MS)).compiler).toBe('nearai')
    expect((await buildState({ ...e, COMPILER_MODE: 'standin' }, sim(), near, base, NOW_MS)).compiler).toBe('standin')
    expect((await buildState({ ...e, COMPILER_MODE: 'standin', NEARAI_API_KEY: 'k' }, sim(), near, base, NOW_MS)).compiler).toBe('nearai')
  })
  it('rulebookMatch compares the wasm request prefix and suffix with the contract (sha256), and a mismatch is false', async () => {
    const { e, near, base } = rig()
    const ok = await buildState(e, sim(), near, base, NOW_MS)
    expect(ok.rulebookMatch).toBe(true)
    expect(ok.rulebookHash).toBe(sim().rulebook().hash)
    for (const over of [{ prefix_sha256: '00'.repeat(32) }, { suffix_sha256: '11'.repeat(32) }, { model_id: 'other/model' }, { prefix_sha256: undefined }]) {
      const { fetchFn } = scriptedRpc({ views: { [`${CONTRACT}:get_config`]: () => configRaw(over), [`${CONTRACT}:get_belts`]: () => [], [`${CONTRACT}:get_fights`]: () => [] }, accounts: {} })
      const s = await buildState(e, sim(), new Rpc({ fetchFn }), base, NOW_MS)
      expect(s.rulebookMatch, JSON.stringify(over)).toBe(false)
    }
  })
  it('a closed current season lists its payouts with chain status', async () => {
    const { e, base } = rig()
    const closed = season({ id: 2, state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [7, 8] })
    const rpc2 = new Rpc({ fetchFn: scriptedRpc({
      views: {
        [`${CONTRACT}:get_config`]: () => configRaw(),
        [`${CONTRACT}:get_belts`]: () => [belt({ season: closed })],
        [`${CONTRACT}:get_fights`]: () => [],
        [`${CONTRACT}:get_payouts`]: () => [payout(7), payout(8, { to: null })],
        'v1.signer-prod.testnet:derived_public_key': () => TEST_DERIVED_KEY,
      }, accounts: {},
    }).fetchFn })
    const s = await buildState(e, sim(), rpc2, base, NOW_MS)
    expect(s.payouts.map((p) => [p.id, p.status])).toEqual([[7, 'unsigned'], [8, 'claimable']])
    expect(s.belts[0]!.seasonState).toBe('Closed')
    expect(s.belts[0]!.lastBell!.seasonId).toBe(2)
  })
  it('the state is cached so a lobby burst costs one build', async () => {
    const { e, near, base, calls } = rig()
    const { cachedJson } = await import('../functions/_lib/cache')
    const load = () => buildState(e, sim(), near, base, NOW_MS)
    await cachedJson(e.TS_KV, 'state:test', 3, load, 8)
    const n = calls.length
    await cachedJson(e.TS_KV, 'state:test', 3, load, 8)
    await cachedJson(e.TS_KV, 'state:test', 3, load, 8)
    expect(calls.length).toBe(n)
  })
})
