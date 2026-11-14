import { beforeEach, describe, expect, it } from 'vitest'
import { decodeSignedTransaction } from '@near-js/transactions'
import { scriptedRpc, sim, type ChainScript } from './helpers'
import { belt, challenge, CONTRACT, fighter, fightRow, hashOf, NEAR, TOLL } from './fixtures'
import { NearClient } from '../src/game/near'
import { archiveStored, exportKey, loadStored, newGuestKeys, saveStored, type KeyStore } from '../src/game/nearKeys'
import { GameError } from '../src/game/client'
import { mapBelt, type RawChallenge, type RawFight } from '../src/game/chain/views'
import { challengeGas } from '../src/game/chain/config'
import { formatPublicKey, parseSecretKey, verify } from '../src/game/chain/keys'
import { fromB64 } from '../src/game/chain/bytes'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeTransaction } from '../src/game/chain/tx'
import { b58encode } from '../src/game/chain/base58'
import type { ForgeProgress, Fight } from '../src/game/types'

class MemStore implements KeyStore {
  m = new Map<string, string>()
  get(k: string) { return this.m.get(k) ?? null }
  set(k: string, v: string) { this.m.set(k, v) }
  remove(k: string) { this.m.delete(k) }
}

const ME = 'brave-badger-07.play.titleshot.testnet'
const B = fighter(1, ME) // the challenger's fighter
const SENTENCE = B.sentence

interface Rig {
  client: NearClient; store: MemStore; script: ChainScript; sent: string[]; apiCalls: { path: string; body?: any }[]
  state: { challenge: RawChallenge | null; pending: 'none' | 'always' | 'afterSend'; sentOnce: boolean; seq: RawChallenge[]; balance: string; fight: RawFight | null; txFailure: string | null; apiFail: Record<string, Response> }
  keys: ReturnType<typeof newGuestKeys>
}

function rig(opts: { account?: boolean; forgeWaitMs?: number; balance?: string } = {}): Rig {
  sim() // pre-load the wasm for loadSim()
  const store = new MemStore()
  const keys = newGuestKeys()
  if (opts.account !== false) saveStored(store, keys, ME)
  const sent: string[] = []
  const apiCalls: Rig['apiCalls'] = []
  const state: Rig['state'] = { challenge: null, pending: 'none', sentOnce: false, seq: [], balance: opts.balance ?? (NEAR / 2n).toString(), fight: fightRow(9, 0, 1), txFailure: null, apiFail: {} }
  const rb = sim().rulebook()
  const beltRaw = belt()
  const fighters = new Map([fighter(0), B].map((f) => [f.hash, f]))
  const script: ChainScript = {
    views: {
      [`${CONTRACT}:balance_of`]: () => state.balance,
      [`${CONTRACT}:get_pending`]: () => (state.pending === 'always' || (state.pending === 'afterSend' && state.sentOnce) ? state.challenge : null),
      [`${CONTRACT}:get_challenge`]: () => (state.seq.length > 1 ? state.seq.shift() : state.seq[0] ?? null),
      [`${CONTRACT}:get_fight`]: () => state.fight,
      [`${CONTRACT}:get_fighter`]: (a: { hash_hex: string }) => fighters.get(a.hash_hex) ?? null,
      [`${CONTRACT}:get_belt`]: () => beltRaw,
      [`${CONTRACT}:get_belts`]: () => [beltRaw],
      [`${CONTRACT}:get_config`]: () => ({ forge_mode: 'relayer' }),
      [`${CONTRACT}:get_fights`]: () => [fightRow(9, 0, 1)],
    },
    accounts: {},
    txs: (hash: string) => (state.txFailure ? { final_execution_status: 'EXECUTED', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${state.txFailure}` } } } } }, transaction_outcome: {}, receipts_outcome: [] } : hash ? undefined : undefined),
    onSend: (b64) => { sent.push(b64); state.sentOnce = true },
  }
  const { fetchFn: rpc } = scriptedRpc(script)
  const stateJson = () => ({ at: 1, contract: CONTRACT, forgeMode: 'outlayer', model: 'm', rulebookHash: rb.hash, belts: [mapBelt(beltRaw, rb)], fights: [], payouts: [], wallets: [], tick: null })
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes('/api/')) {
      const path = new URL(url, 'https://t.test').pathname
      apiCalls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const fail = state.apiFail[path]
      if (fail) return fail.clone()
      if (path === '/api/state') return new Response(JSON.stringify(stateJson()))
      if (path === '/api/guest') return new Response(JSON.stringify({ accountId: ME }))
      if (path === '/api/preview') return new Response(JSON.stringify({ spec: { name: 'X', moves: [] }, canonical: false, portrait: '/api/portrait/ab', hash: 'ab', signer: '0xabc' }))
    }
    return rpc(url, init!)
  }) as unknown as typeof fetch
  const client = new NearClient({ contractId: CONTRACT, fetchFn, store, sleep: async () => undefined, pollMs: 1, forgeWaitMs: opts.forgeWaitMs ?? 1000 })
  return { client, store, script, sent, apiCalls, state, keys }
}

const run = (r: Rig, onProgress: (p: ForgeProgress) => void = () => undefined) => r.client.challenge('1', SENTENCE, onProgress)
const resolved = (fightId = 9): RawChallenge => challenge({ id: 5, status: 'Resolved', fight_id: fightId, challenger: ME })
const forging = (): RawChallenge => challenge({ id: 5, challenger: ME })

describe('guest account', () => {
  it('no stored account is signed out; a stored one shows its contract balance', async () => {
    expect(await rig({ account: false }).client.account()).toBeNull()
    const r = rig()
    expect(await r.client.account()).toEqual({ id: ME, kind: 'guest', balanceYocto: (NEAR / 2n).toString(), claimableYocto: '0' })
  })
  it('an unreachable chain keeps the player signed in with a zero balance', async () => {
    const r = rig()
    delete r.script.views[`${CONTRACT}:balance_of`]
    expect(await r.client.account()).toMatchObject({ id: ME, balanceYocto: '0' })
  })
  it('createGuest sends only PUBLIC keys, stores both secret keys locally and never calls twice', async () => {
    const r = rig({ account: false })
    const acct = await r.client.createGuest()
    expect(acct.id).toBe(ME)
    const body = r.apiCalls.find((c) => c.path === '/api/guest')!.body
    expect(Object.keys(body).sort()).toEqual(['publicKey', 'sessionKey'])
    const stored = loadStored(r.store)!
    expect(stored.accountId).toBe(ME)
    expect(body.publicKey).toBe(formatPublicKey(parseSecretKey(stored.fullKey).publicKey))
    expect(body.sessionKey).toBe(formatPublicKey(parseSecretKey(stored.sessionKey).publicKey))
    expect(JSON.stringify(body)).not.toContain(stored.fullKey.slice(8))
    expect(JSON.stringify(body)).not.toContain(stored.sessionKey.slice(8))
    expect(body.publicKey).not.toBe(body.sessionKey)
    await r.client.createGuest()
    expect(r.apiCalls.filter((c) => c.path === '/api/guest').length).toBe(1)
  })
  it('a dry faucet is a readable error and stores nothing', async () => {
    const r = rig({ account: false })
    r.state.apiFail['/api/guest'] = new Response(JSON.stringify({ error: 'The guest faucet is empty right now. Try again later.', code: 'SPONSOR_DRY' }), { status: 503 })
    const e = await r.client.createGuest().catch((x) => x)
    expect(e).toBeInstanceOf(GameError)
    expect(e.code).toBe('SPONSOR_DRY')
    expect(loadStored(r.store)).toBeNull()
  })
  it('sign out archives the account so the key can still be exported; export hands back the full-access key', async () => {
    const r = rig()
    expect(exportKey(r.store)).toMatchObject({ accountId: ME })
    expect(exportKey(r.store)!.privateKey.startsWith('ed25519:')).toBe(true)
    await r.client.signOut()
    expect(await r.client.account()).toBeNull()
    expect(JSON.parse(r.store.get('ts-account-archive')!)[0].accountId).toBe(ME)
    archiveStored(r.store) // signing out twice is harmless
  })
})

describe('reads', () => {
  it('belts come from /api/state and belt(id) finds them; an unknown belt is E_NO_BELT', async () => {
    const r = rig()
    const belts = await r.client.belts()
    expect(belts.map((b) => b.name)).toEqual(['The Midnight Belt'])
    expect((await r.client.belt('1')).id).toBe('1')
    await expect(r.client.belt('99')).rejects.toMatchObject({ code: 'E_NO_BELT' })
  })
  it('when /api/state is down the client reads the contract directly', async () => {
    const r = rig()
    r.state.apiFail['/api/state'] = new Response('upstream exploded', { status: 500 })
    const belts = await r.client.belts()
    expect(belts[0]!.champion.spec.name).toBe('Counselor Coo')
    expect((await r.client.history())[0]).toMatchObject({ id: '9', championName: 'Counselor Coo' })
  })
  it('both failing is a GameError, not a crash', async () => {
    const r = rig()
    r.state.apiFail['/api/state'] = new Response('x', { status: 500 })
    delete r.script.views[`${CONTRACT}:get_belts`]
    await expect(r.client.belts()).rejects.toBeInstanceOf(GameError)
  })
  it('preview validates locally and maps API refusals', async () => {
    const r = rig()
    await expect(r.client.preview('ab')).rejects.toMatchObject({ code: 'E_SENTENCE' })
    expect(r.apiCalls.length).toBe(0)
    const ok = await r.client.preview('  a  very polite   kraken ')
    expect(r.apiCalls[0]!.body).toEqual({ sentence: 'a very polite kraken' })
    expect(ok).toMatchObject({ canonical: false, portrait: '/api/portrait/ab', signer: '0xabc' })
    r.state.apiFail['/api/preview'] = new Response(JSON.stringify({ error: 'x', code: 'REFUSED' }), { status: 422 })
    await expect(r.client.preview('something rude here')).rejects.toMatchObject({ code: 'REFUSED', message: expect.stringContaining('refused') })
    r.state.apiFail['/api/preview'] = new Response('{}', { status: 429 })
    await expect(r.client.preview('another try here')).rejects.toMatchObject({ code: 'HTTP_429' })
  })
  it('odds come from the wasm and a sealed rule averages all rules', async () => {
    const r = rig()
    const b = await r.client.belt('1')
    const o = r.client.odds(b.champion.spec, B.spec as never, 255, 80)
    expect(o.n).toBe(80)
    expect(o.win + o.draw + o.loss).toBeCloseTo(1, 5)
  })
})

describe('challenge: the paid forge from the browser', () => {
  let r: Rig
  beforeEach(() => { r = rig() })

  it('signs `challenge` with the SESSION key, then streams toll, tee, compile, verify and fight, and returns a verified replay', async () => {
    r.state.challenge = forging()
    r.state.pending = 'afterSend'
    r.state.seq = [forging(), forging(), resolved()]
    const stages: ForgeProgress[] = []
    const fight = (await run(r, (p) => stages.push(p))) as Fight & { verified: boolean }
    expect(stages.map((s) => s.stage)).toEqual(['toll', 'tee', 'compile', 'verify', 'fight'])
    expect(stages[0]!.receipt!.url).toContain('nearblocks.io/txns/')
    expect(stages[0]!.note).toContain('0.1 NEAR')
    expect(fight.verified).toBe(true)
    expect(fight.events.length).toBeGreaterThan(5)
    expect(fight.events[0]!.t).toBe('match_start')
    expect(fight.id).toBe('9')
    expect(fight.winner).toBe(r.state.fight!.winner_code)
    expect(fight.champion.spec.name).toBe('Counselor Coo')
    expect(fight.split.forgeFee).toBe(belt().forge_fee)
    expect(fight.receipts[0]!.label).toBe('challenge')
    // exactly one transaction, a 0 deposit `challenge` call signed by the session key (not the full-access key), with the gas
    // the contract's forge mode needs: 50 Tgas in relayer mode (a 300 Tgas call is dropped for a guest holding 0.1 NEAR)
    expect(r.sent.length).toBe(1)
    const dec = decodeSignedTransaction(fromB64(r.sent[0]!))
    expect(dec.transaction.signerId).toBe(ME)
    expect(dec.transaction.receiverId).toBe(CONTRACT)
    const fc = dec.transaction.actions[0]!.functionCall!
    expect(fc.methodName).toBe('challenge')
    expect(fc.gas).toBe(50_000_000_000_000n)
    expect(challengeGas('outlayer')).toBe(300_000_000_000_000n)
    expect(challengeGas(undefined)).toBe(50_000_000_000_000n)
    expect(fc.deposit).toBe(0n)
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args as ArrayLike<number>)))).toEqual({ belt_id: 1, sentence: SENTENCE })
    const stored = loadStored(r.store)!
    const body = encodeTransaction({ signerId: ME, receiverId: CONTRACT, nonce: dec.transaction.nonce, blockHash: b58encode(Uint8Array.from(dec.transaction.blockHash as ArrayLike<number>)), actions: [{ kind: 'functionCall', method: 'challenge', args: Uint8Array.from(fc.args as ArrayLike<number>), gas: fc.gas, deposit: 0n }] }, parseSecretKey(stored.sessionKey).publicKey)
    const sigBytes = (dec.signature as any).ed25519Signature?.data ?? (dec.signature as any).data
    expect(verify(Uint8Array.from(sigBytes), sha256(body), parseSecretKey(stored.sessionKey).publicKey)).toBe(true)
    expect(verify(Uint8Array.from(sigBytes), sha256(body), parseSecretKey(stored.fullKey).publicKey)).toBe(false)
  })
  it('a replay that does not match the contract state hash is reported as not verified', async () => {
    r.state.challenge = forging(); r.state.pending = 'afterSend'; r.state.seq = [resolved()]
    r.state.fight = { ...r.state.fight!, state_hash: 'ff'.repeat(32) }
    expect(((await run(r)) as Fight & { verified: boolean }).verified).toBe(false)
  })
  it('a winner the replay disagrees with is also not verified', async () => {
    r.state.challenge = forging(); r.state.pending = 'afterSend'; r.state.seq = [resolved()]
    r.state.fight = { ...r.state.fight!, winner_code: ((r.state.fight!.winner_code + 1) % 3) as 0 | 1 | 2 }
    expect(((await run(r)) as Fight & { verified: boolean }).verified).toBe(false)
  })
  it('too little balance is E_BALANCE with the top-up amount, and no transaction is sent', async () => {
    r = rig({ balance: (NEAR / 25n).toString() })
    const e = await run(r).catch((x) => x)
    expect(e).toMatchObject({ code: 'E_BALANCE' })
    expect(e.message).toBe('Top up: you need 0.1 NEAR for the toll and have 0.04.')
    expect(r.sent.length).toBe(0)
  })
  it('another fight already forging is E_PENDING, no transaction', async () => {
    r.state.challenge = challenge({ sentence: 'a completely different sentence', challenger: ME }); r.state.pending = 'always'
    await expect(run(r)).rejects.toMatchObject({ code: 'E_PENDING' })
    expect(r.sent.length).toBe(0)
  })
  it('a reload mid-forge resumes the same challenge without paying again', async () => {
    r.state.challenge = forging(); r.state.pending = 'always'; r.state.seq = [forging(), resolved()]
    const stages: string[] = []
    await run(r, (p) => stages.push(p.stage))
    expect(r.sent.length).toBe(0)
    expect(stages).toContain('fight')
  })
  it('invalid sentences, no account and unknown belts fail before any network call', async () => {
    await expect(r.client.challenge('1', 'ab', () => undefined)).rejects.toMatchObject({ code: 'E_SENTENCE' })
    await expect(r.client.challenge('1', 'x\u0000y z', () => undefined)).rejects.toMatchObject({ code: 'E_SENTENCE' })
    await expect(r.client.challenge('7', SENTENCE, () => undefined)).rejects.toMatchObject({ code: 'E_NO_BELT' })
    await expect(rig({ account: false }).client.challenge('1', SENTENCE, () => undefined)).rejects.toMatchObject({ code: 'E_NO_ACCOUNT' })
    expect(r.sent.length).toBe(0)
  })
  it('a rejected or refunded forge ends in a readable error that says the toll came back', async () => {
    for (const [c, code] of [[challenge({ id: 5, status: 'Rejected', code: 'E_REFUSED' }), 'E_REFUSED'], [challenge({ id: 5, status: 'Refunded', code: 'E_FORGE_FAILED' }), 'E_FORGE_FAILED'], [challenge({ id: 5, status: 'Rejected', code: 'E_AI_SIG' }), 'E_AI_SIG']] as const) {
      const rr = rig()
      rr.state.challenge = forging(); rr.state.pending = 'afterSend'; rr.state.seq = [forging(), c]
      const e = await run(rr).catch((x) => x)
      expect(e).toBeInstanceOf(GameError)
      expect(e.code).toBe(code)
      expect(e.message).toMatch(/refunded|Refused|refused/i)
    }
  })
  it('a challenge tx that fails on chain (E_SELF) surfaces the contract code as a sentence', async () => {
    r.state.txFailure = 'E_SELF'
    const e = await run(r).catch((x) => x)
    expect(e).toMatchObject({ code: 'E_SELF', message: expect.stringContaining('hold this belt') })
  })
  it('an exhausted function-call key allowance or empty gas balance is a readable error', async () => {
    r.script.onSend = () => 'Access Key {account_id: x} does not have enough allowance (NotEnoughAllowance)'
    await expect(run(r)).rejects.toMatchObject({ code: 'E_ALLOWANCE' })
    const r2 = rig()
    r2.script.onSend = () => 'Account has NotEnoughBalance to cover the transaction cost'
    await expect(run(r2)).rejects.toMatchObject({ code: 'E_GAS_BALANCE' })
  })
  it('a forge that never finishes tells the player the toll is safe instead of spinning forever', async () => {
    r = rig({ forgeWaitMs: 5 })
    r.state.challenge = forging(); r.state.pending = 'afterSend'; r.state.seq = [forging()]
    const real = Date.now
    let t = real()
    Date.now = () => (t += 20)
    try {
      const e = await run(r).catch((x) => x)
      expect(e).toMatchObject({ code: 'E_SLOW' })
      expect(e.message).toMatch(/toll is safe/)
    } finally { Date.now = real }
  })
  it('an opener-style resolution without a fight is reported, not crashed on', async () => {
    r.state.challenge = forging(); r.state.pending = 'afterSend'; r.state.seq = [challenge({ id: 5, status: 'Resolved', fight_id: null })]
    await expect(run(r)).rejects.toMatchObject({ code: 'E_STATE' })
  })
})

describe('fight(id) replays and verifies any bout', () => {
  it('an unknown fight, or one whose fighter is missing, is a clear error', async () => {
    const r = rig()
    r.state.fight = null
    await expect(r.client.fight('3')).rejects.toMatchObject({ code: 'E_NO_FIGHT' })
    r.state.fight = fightRow(9, 0, 1, { challenger_hash: hashOf('nobody forged this') })
    await expect(r.client.fight('9')).rejects.toMatchObject({ code: 'E_NO_FIGHTER' })
  })
  it('history is filtered by belt', async () => {
    const r = rig()
    expect((await r.client.history('2')).length).toBe(0)
    expect(TOLL).toBeTruthy()
  })
})
