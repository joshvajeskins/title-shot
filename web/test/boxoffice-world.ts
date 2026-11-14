// Box-office test world: a scripted NEAR contract that decodes the signed transactions it receives (create, deposit_for,
// challenge, set_evm_address, add key), a fake x402 facilitator, a fake Base RPC, and the real agent script's payment
// builder, so the tests pay the endpoint exactly the way scripts/x402-agent.mjs does.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from '@noble/hashes/sha2.js'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { b58encode } from '../src/game/chain/base58'
import { fromB64, toB64, utf8 } from '../src/game/chain/bytes'
import { generateKeyPair } from '../src/game/chain/keys'
import { Rpc } from '../src/game/chain/rpc'
import { Signer } from '../src/game/chain/signer'
import { sentenceHash } from '../src/game/chain/views'
import { Chain } from '../functions/_lib/chain'
import type { BoxDeps } from '../functions/_lib/boxoffice'
import { boxConfig } from '../functions/_lib/boxofficeQuote'
import { FacilitatorDown, NETWORK, type SettleResult, type VerifyResult } from '../functions/_lib/x402'
import { env, json, ROOT, scriptedRpc, TEST_ADDRESS, TEST_DERIVED_KEY } from './helpers'

export const NEAR = 10n ** 24n
export const CONTRACT = 'ring.titleshot.testnet'
export const SPONSOR = 'play.titleshot.testnet'
export const VANCE_ADDR = TEST_ADDRESS.toLowerCase() // the fake MPC signer derives the test identity's address
export const CHAMP = 'a pigeon with a law degree and nothing to lose'
export const SETTLE_TX = '0x' + 'ab'.repeat(32)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const agent: any = await import(pathToFileURL(join(ROOT, 'scripts/x402-agent.mjs')).href)

export function beltFixture(over: Record<string, unknown> = {}) {
  const closes = BigInt(Date.now() + 3_600_000) * 1_000_000n
  return {
    id: 1, name: 'The Midnight Belt', token_id: 'belt-1', promoter: 'vance.titleshot.testnet', holder: 'vance.titleshot.testnet',
    toll: (NEAR / 20n).toString(), forge_fee: (NEAR / 100n).toString(), purse_chain_id: 84532, media: '',
    season: { id: 3, state: 'Open', duration_sec: 21600, opens_at: '0', closes_at: closes.toString(), rule: null, sealed: true, side_pot: '0', bouts: 0, challenges: 0, pending: 0, purse: { chain_id: 84532, path: 'belt-1-s3', amount_wei: '0', address: null, next_nonce: 0 }, defence_count: [], payouts: [], final_holder: null },
    champion: { hash: sentenceHash(CHAMP), sentence: CHAMP, spec: {}, writer: 'vance.titleshot.testnet', forged_at: '0', signer: '', record: { wins: 0, losses: 0, draws: 0 } },
    reign_since: '0', defences: 0, fights: 0, top_defenders: [], ...over,
  }
}

/** signer, receiver and the action kind of a signed NEAR transaction (borsh: signer, key, nonce, receiver, ...). */
function decodeTx(b64: string) {
  const bytes = fromB64(b64)
  const body = bytes.slice(0, bytes.length - 65) // body || key type (1) || ed25519 signature (64)
  const dv = new DataView(body.buffer, body.byteOffset)
  const str = (o: number) => { const n = dv.getUint32(o, true); return { s: new TextDecoder().decode(body.slice(o + 4, o + 4 + n)), end: o + 4 + n } }
  const signer = str(0)
  const receiver = str(signer.end + 33 + 8)
  const text = new TextDecoder('latin1').decode(body)
  const kind = text.includes('deposit_for') ? 'deposit' : text.includes('set_evm_address') ? 'evm' : text.includes('"belt_id"') ? 'challenge' : receiver.s.endsWith(`.${SPONSOR}`) && signer.s === SPONSOR ? 'create' : 'addkey'
  const args = /\{"belt_id":(\d+),"sentence":("(?:[^"\\]|\\.)*")\}/.exec(text)
  // a single function-call action ends with its gas (u64) and deposit (u128), little endian; the nonce follows the signer's key
  const le = (from: number, n: number) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(body[from + i]!); return v }
  const deposit = le(body.length - 16, 16)
  const gas = le(body.length - 24, 8)
  const nonce = le(signer.end + 33, 8)
  return { hash: b58encode(sha256(body)), signer: signer.s, receiver: receiver.s, kind, deposit, gas, nonce, belt: args ? Number(args[1]) : 0, sentence: args ? JSON.parse(args[2]!) as string : '' }
}

const ok = (v?: unknown) => ({ status: { SuccessValue: v === undefined ? '' : toB64(utf8(JSON.stringify(v))) }, receipts_outcome: [], transaction: {} })
const fail = (code: string) => ({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } }, receipts_outcome: [], transaction: {} })

export interface WorldOpts {
  belt?: Record<string, unknown>; challengeFails?: string; depositFails?: boolean; forgeMode?: 'relayer' | 'outlayer'
  /** this many `challenge` broadcasts are accepted by the RPC and then never land (what testnet did to 300 Tgas from a 0.1 NEAR guest) */
  dropChallenges?: number
  /** this many `challenge` sends are refused with NotEnoughAllowance */
  allowanceOut?: number
}

export function world(o: WorldOpts = {}) {
  const sent: ReturnType<typeof decodeTx>[] = []
  const results = new Map<string, unknown>()
  const accounts: Record<string, bigint> = { [SPONSOR]: 100n * NEAR }
  const pending = new Map<string, unknown>()
  const opts = o
  let nextId = 41
  const rpc = scriptedRpc({
    views: {
      [`${CONTRACT}:get_belt`]: () => beltFixture(opts.belt),
      [`${CONTRACT}:get_belts`]: () => [beltFixture(opts.belt)],
      [`${CONTRACT}:get_pending`]: (a) => pending.get(a.account) ?? null,
      [`${CONTRACT}:get_deploy_gates`]: () => ({ ok: true, ready: true, failing: [] }),
      [`${CONTRACT}:get_compile_caps`]: () => ({ daily: 60, total: 250, today: 1, used: 1, day: 1, open: true }),
      [`${CONTRACT}:get_fighter_by_sentence`]: () => null,
      [`${CONTRACT}:get_config`]: () => ({ forge_mode: opts.forgeMode ?? 'relayer' }),
      'v1.signer-prod.testnet:derived_public_key': () => TEST_DERIVED_KEY,
    },
    accounts,
    txs: (h) => results.get(h),
    onSend: (b64) => {
      const t = decodeTx(b64)
      sent.push(t)
      if (t.kind === 'create') { accounts[t.receiver] = NEAR / 10n; results.set(t.hash, ok()) }
      else if (t.kind === 'deposit') results.set(t.hash, opts.depositFails ? fail('E_STORAGE') : ok('1'))
      else if (t.kind === 'challenge') {
        if (opts.allowanceOut && opts.allowanceOut-- > 0) return 'InvalidTxError: NotEnoughAllowance'
        if (opts.dropChallenges && opts.dropChallenges-- > 0) return // accepted, never lands: unknown hash, key nonce unchanged
        if (opts.challengeFails) { results.set(t.hash, fail(opts.challengeFails)); return }
        const id = nextId++
        pending.set(t.signer, { id, belt_id: t.belt, sentence: t.sentence, challenger: t.signer, status: 'Forging' })
        results.set(t.hash, ok(id))
      } else results.set(t.hash, ok())
    },
  })
  // belt 99 does not exist: the real contract's get_belt panics E_NO_BELT, which a view reports as `result.error`
  const fetchFn = (async (url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    if (method === 'query' && params.method_name === 'get_belt' && JSON.parse(atob(params.args_base64)).id === 99) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "E_NO_BELT" })', logs: [] } }))
    }
    return rpc.fetchFn(url, init)
  }) as unknown as typeof fetch
  const near = new Rpc({ urls: ['https://near.test'], fetchFn })
  return { rpc: { ...rpc, fetchFn }, near, sent, accounts, pending, opts, kinds: () => sent.map((t) => t.kind) }
}
export type World = ReturnType<typeof world>

export function facilitator(o: { verify?: VerifyResult | 'down'; settle?: SettleResult | 'down' } = {}) {
  const calls = { verify: 0, settle: 0 }
  return {
    calls, o,
    f: {
      verify: async () => { calls.verify++; if (o.verify === 'down') throw new FacilitatorDown('verify'); return o.verify ?? { isValid: true } },
      settle: async () => { calls.settle++; if (o.settle === 'down') throw new FacilitatorDown('settle'); return o.settle ?? { success: true, transaction: SETTLE_TX, network: NETWORK } },
    },
  }
}

/** Base RPC whose USDC `authorizationState` answers `used` (null = the node fails). */
export function baseRpc(state: { used: boolean | null }) {
  return new Rpc({ urls: ['https://base.test'], fetchFn: (async (_u: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body))
    if (state.used === null) return new Response('down', { status: 500 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + (state.used ? '1' : '0').padStart(64, '0') }))
  }) as unknown as typeof fetch })
}

export function deps(w: World, fac: ReturnType<typeof facilitator>, base = baseRpc({ used: false }), over: Partial<BoxDeps> = {}): BoxDeps {
  const e = env({ CONTRACT_ID: CONTRACT })
  return {
    env: e, kv: e.TS_KV, chain: new Chain(e, w.near), base, sponsor: new Signer(SPONSOR, generateKeyPair(), w.near), seed: 'test-box-seed',
    facilitator: fac.f, cfg: boxConfig(e), econ: { gas: NEAR / 10n, floorNear: 0.8 }, now: () => Date.now(), sleep: async () => undefined,
    pollMs: 1, resolveMs: 3, ...over,
  }
}

export const newPayer = () => privateKeyToAccount(generatePrivateKey())
export const ask = (body: unknown, headers: Record<string, string> = {}) => json('/api/boxoffice/challenge', body, { headers: { 'cf-connecting-ip': '7.7.7.7', ...headers } })

/** The agent's way to pay: read PAYMENT-REQUIRED from a 402, sign the EIP-3009 authorization, return the header value. */
export async function payHeader(r402: Response, payer: ReturnType<typeof newPayer>, opts: { nowSec?: number; nonce?: string } = {}): Promise<string> {
  const pr = agent.unb64json(r402.headers.get('payment-required'))
  const req = agent.pickRequirements(pr, { maxUnits: 1_000_000n, payTo: VANCE_ADDR })
  return agent.b64json(await agent.buildPayment(payer, pr, req, opts))
}
