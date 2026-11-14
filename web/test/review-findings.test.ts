// Senior review 2026-11-14: failing tests for the high findings. Each must turn green with the fix (do not weaken them).
import { describe, expect, it } from 'vitest'
import { parseTransaction, type Hex } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { MemKV, TEST_ADDRESS, TEST_DERIVED_KEY } from './helpers'
import { belt, NOW_MS, ns, payout, season, challenge } from './fixtures'
import { run, setup, world, type World } from './tick-rig'
import { putJson } from '../functions/_lib/cache'
import { txHashOf } from '../functions/_lib/evm'
import { VANCE_PATH } from '../functions/_lib/purse'
import { b58encode } from '../src/game/chain/base58'
import { utf8 } from '../src/game/chain/bytes'
import type { KVLike } from '../functions/_lib/env'
import type { TickDeps } from '../functions/_lib/tickTypes'

/** Workers KV with real expiry (MemKV ignores expirationTtl), driven by the world's clock. */
class TtlKV extends MemKV {
  exp = new Map<string, number>()
  constructor(private clock: () => number) { super() }
  override async get(key: string, type?: 'arrayBuffer'): Promise<any> {
    const e = this.exp.get(key)
    if (e !== undefined && e <= this.clock()) { this.store.delete(key); this.exp.delete(key) }
    return super.get(key, type)
  }
  override async put(key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl) this.exp.set(key, this.clock() + opts.expirationTtl * 1000); else this.exp.delete(key)
    return super.put(key, value)
  }
}

/** Each derivation path gets its own address (the rig returns one key for every path, so purse == Vance there). */
const keyFor = (path: string) => (path === VANCE_PATH ? TEST_DERIVED_KEY : 'secp256k1:' + b58encode(secp256k1.getPublicKey(sha256(utf8('purse|' + path)), false).slice(1)))

/** A Base Sepolia ledger: per-address balances, a pending nonce that follows the broadcasts, transfers credited on send. */
function withLedger(d: TickDeps, w: World, sent: string[]) {
  const ledger = new Map<string, bigint>([[TEST_ADDRESS.toLowerCase(), w.baseBalance]])
  ;(d.near as any).view = async (_c: string, m: string, a: any) => { if (m === 'derived_public_key') return keyFor(a.path); throw new Error('no view ' + m) }
  const orig = (d.base as any).call
  ;(d.base as any).call = async (m: string, p: any[]) => {
    if (m === 'eth_getTransactionCount') return '0x' + (3 + sent.length).toString(16)
    if (m === 'eth_getBalance') return '0x' + (ledger.get(String(p[0]).toLowerCase()) ?? 0n).toString(16)
    const r = await orig(m, p)
    if (m === 'eth_sendRawTransaction') {
      const tx = parseTransaction(p[0] as Hex)
      const to = String(tx.to).toLowerCase()
      ledger.set(to, (ledger.get(to) ?? 0n) + (tx.value ?? 0n))
      ledger.set(TEST_ADDRESS.toLowerCase(), (ledger.get(TEST_ADDRESS.toLowerCase()) ?? 0n) - (tx.value ?? 0n))
    }
    return r
  }
  return ledger
}

const fundings = (sent: string[]) => new Set(sent.map(txHashOf)).size
const closedBelt = () => belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', closes_at: ns(NOW_MS - 120_000) }) })

describe('HIGH: a season purse is funded at most once (idempotence must come from chain state, not a 1 h / per-colo KV record)', () => {
  it('open_season keeps failing (e.g. Vance short of NEAR): an hour later the tick must not fund the same purse again', async () => {
    const w = world({ autoMine: true, belts: [closedBelt()], failures: { open_season: 'Smart contract panicked: E_FEE' } })
    const { d, sent } = setup(w)
    d.env.TS_KV = new TtlKV(() => w.now) as unknown as KVLike
    withLedger(d, w, sent)
    await run(d)
    expect(fundings(sent)).toBe(1)
    w.now += 61 * 60_000 // fund:<belt>:<season> was written with a 3600 s TTL
    await run(d)
    w.now += 61 * 60_000
    await run(d)
    expect(fundings(sent), 'every expiry of the KV record funded season 3 again; the extra ETH is stranded in the purse address').toBe(1)
  })

  it('two ticks that do not see each other\'s KV writes (cron colo vs a lobby colo) fund the season once', async () => {
    const w = world({ autoMine: true, belts: [closedBelt()] })
    const { d, sent } = setup(w)
    withLedger(d, w, sent)
    await run(d) // tick A (lobby): funds, then its open_season is still in flight when tick B reads the belts
    d.env.TS_KV = new MemKV() // tick B (bell cron, another colo): KV is eventually consistent, A's lock and fund record are invisible
    await run(d)
    expect(fundings(sent), 'tick B funded season 3 a second time').toBe(1)
  })
})

describe('HIGH: bell payouts with no registered EVM address are never paid (nothing in the stack calls set_evm_address / claim_payout)', () => {
  it('Vance claims its own zero-challenge refund to its Chain-Signatures address so the payout can be signed', async () => {
    const s = season({ state: 'Closed', bouts: 0, challenges: 0, defence_count: [], final_holder: 'vance.titleshot.testnet', payouts: [1] })
    const w = world({ belts: [belt({ holder: 'vance.titleshot.testnet', season: s })], payouts: { '1:2': [payout(1, { payee: 'vance.titleshot.testnet', to: null, amount_wei: '2000000000000000' })] } })
    const { d, calls } = setup(w)
    await run(d)
    const claim = calls.find((c) => c.method === 'claim_payout')
    expect(claim, 'the promoter refund stays "claimable" forever and its ETH is stranded in the season purse').toBeDefined()
    expect(claim).toMatchObject({ who: 'vance.titleshot.testnet', args: { payout_id: 1 }, deposit: 1n })
    expect(String(claim!.args.addr).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase())
  })
})

describe('HIGH: tick state in KV is not scoped to the contract (staging -> production on the same Pages project and KV)', () => {
  it('a payout record left by another contract (same payout id) does not stop this contract\'s payout from being broadcast', async () => {
    const raw = '0x02f8ee'
    const s = season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1] })
    const w = world({ belts: [belt({ season: s })], payouts: { '1:2': [payout(1, { raw_tx: raw, nonce: 0 })] } })
    const { d, kv, sent } = setup(w)
    // written by the staging contract's tick; payout ids restart at 1 on every new contract and payout:<id> has no TTL
    await putJson(kv, 'payout:1', { hash: '0x' + '99'.repeat(32), status: 'mined', at: NOW_MS - 86_400_000, contract: 'staging.titleshot.testnet' })
    await run(d)
    expect(sent, 'the production payout is treated as already mined (and /api/state links the staging tx)').toEqual([raw])
  })

  it('a sweep cursor left by another contract does not freeze expiry of this contract\'s stuck challenges', async () => {
    const stuck = challenge({ id: 3, created_at: ns(NOW_MS - 11 * 60_000) })
    const w = world({ belts: [], challenges: { 3: stuck }, nextChallenge: 6 })
    const { d, kv, calls } = setup(w)
    await putJson(kv, 'sweep:cursor', 40) // staging had reached challenge 40; production starts at 1
    await run(d)
    expect(calls.filter((c) => c.method === 'expire_challenge').map((c) => c.args.id), 'cursor 40 >= next 6: nothing is swept until production passes 40').toEqual([3])
  })
})
