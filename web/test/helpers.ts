// Shared test fixtures: in-memory KV, the real bout-sim wasm, a scripted NEAR RPC and a test signing key.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Ctx } from '../functions/_lib/http'
import type { Env, KVLike } from '../functions/_lib/env'
import { resetRateMemory } from '../functions/_lib/ratelimit'
import { resetLedgerMemory } from '../functions/_lib/ledger'
import { loadSimSync, type Sim } from '../src/sim'
import { concat, fromHex, toHex, utf8 } from '../src/game/chain/bytes'
import { eip191Digest, sha256Hex } from '../src/game/chain/signature'
import { b58encode } from '../src/game/chain/base58'
import { checkArgs } from './contract-abi'

export const ROOT = join(__dirname, '..', '..')

export class MemKV implements KVLike {
  store = new Map<string, string | ArrayBuffer>()
  puts = 0
  /** a new fake KV is a new world: the in-isolate rate-limit counters start empty, like a cold isolate */
  constructor() { resetRateMemory(); resetLedgerMemory() }
  async get(key: string, type?: 'arrayBuffer'): Promise<any> {
    const v = this.store.get(key)
    if (v === undefined) return null
    if (type === 'arrayBuffer') return typeof v === 'string' ? utf8(v).buffer : v
    return typeof v === 'string' ? v : new TextDecoder().decode(v)
  }
  async put(key: string, value: string | ArrayBuffer): Promise<void> { this.puts++; this.store.set(key, value) }
  async delete(key: string): Promise<void> { this.store.delete(key) }
}

export const env = (over: Partial<Env> = {}): Env => ({ TS_KV: new MemKV(), ...over })

export const ctx = (request: Request, e: Env, params: Record<string, string> = {}): Ctx => ({ request, env: e, params, waitUntil: () => undefined })

let cached: Sim | null = null
export function sim(): Sim {
  cached ??= loadSimSync(readFileSync(join(ROOT, 'web/src/sim/pkg/bout_sim_bg.wasm')))
  return cached
}

export const json = (url: string, body: unknown, init: RequestInit = {}) =>
  new Request(`https://t.test${url}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init, headers: { 'content-type': 'application/json', ...(init.headers as object) } })

export const archetypes = (): { sentence: string; raw: Record<string, unknown> }[] =>
  JSON.parse(readFileSync(join(ROOT, 'crates/bout-sim/fixtures/archetypes.json'), 'utf8'))

// ---- a test ECDSA identity that stands in for NEAR AI's signing key and for the MPC network
export const TEST_SK = sha256(utf8('title-shot-test-signing-identity'))
const pub = secp256k1.getPublicKey(TEST_SK, false)
export const TEST_ADDRESS = '0x' + toHex(keccak_256(pub.slice(1)).slice(12))
export const TEST_DERIVED_KEY = 'secp256k1:' + b58encode(pub.slice(1))

/** 65-byte r||s||v(27/28) EIP-191 signature of `text`, hex without 0x (the NEAR AI format). */
export function signEip191(text: string): string {
  const sig = secp256k1.sign(eip191Digest(text), TEST_SK, { prehash: false, format: 'recovered' }) // recovery byte first
  return toHex(concat(sig.slice(1), Uint8Array.of(sig[0]! + 27)))
}

/** Sign a 32-byte digest like the MPC signer: {big_r, s, recovery_id}. */
export function mpcSign(digestHex: string) {
  const sig = secp256k1.sign(fromHex(digestHex), TEST_SK, { prehash: false, format: 'recovered' })
  return { scheme: 'Secp256k1', big_r: { affine_point: '02' + toHex(sig.slice(1, 33)) }, s: { scalar: toHex(sig.slice(33, 65)) }, recovery_id: sig[0]! }
}

/** A recorded-format NEAR AI exchange for `sentence`, signed by the test identity (provider_tee text). */
export function recordedExchange(s: Sim, model: string, sentence: string, content: string, kind: 'provider_tee' | 'gateway' = 'provider_tee') {
  const prefix = s.requestParts(model)
  const req = utf8(prefix.prefix + JSON.stringify(sentence).slice(1, -1) + prefix.suffix)
  const id = 'chatcmpl-test-' + sha256Hex(req).slice(0, 12)
  const response = JSON.stringify({ id, object: 'chat.completion', model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 1500, completion_tokens: 120, total_tokens: 1620 } })
  const h = `${sha256Hex(req)}:${sha256Hex(utf8(response))}`
  const text = kind === 'provider_tee' ? `${model}:${h}` : h
  return { id, response, text, signature: signEip191(text), signing_address: TEST_ADDRESS, kind, req }
}

// ---- scripted NEAR RPC
export interface ChainScript {
  views: Record<string, (args: any) => unknown> // "contract:method"
  accounts?: Record<string, bigint>
  nonce?: bigint
  txs?: Record<string, any> | ((hash: string) => any) // tx hash -> `tx` RPC result
  onSend?: (signedBase64: string) => string | void // return a message to make send_tx fail
}

export function scriptedRpc(s: ChainScript): { fetchFn: typeof fetch; calls: { method: string; params: any }[] } {
  const calls: { method: string; params: any }[] = []
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    calls.push({ method, params })
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
    const err = (name: string, message = name) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name }, message, data: message } }))
    if (method === 'query' && params.request_type === 'call_function') {
      const fn = s.views[`${params.account_id}:${params.method_name}`]
      if (!fn) return err('CONTRACT_VIEW', `no view ${params.account_id}:${params.method_name}`)
      const args = JSON.parse(atob(params.args_base64))
      if (params.account_id.endsWith('titleshot.testnet')) checkArgs(params.method_name, args) // the fake accepts only what the real contract does
      const out = fn(args)
      return ok({ result: Array.from(utf8(out === undefined ? '' : JSON.stringify(out))), logs: [] })
    }
    if (method === 'query' && params.request_type === 'view_account') {
      const bal = s.accounts?.[params.account_id]
      return bal === undefined ? err('UNKNOWN_ACCOUNT') : ok({ amount: bal.toString() })
    }
    if (method === 'query' && params.request_type === 'view_access_key') return ok({ nonce: Number(s.nonce ?? 10n) })
    if (method === 'block') return ok({ header: { hash: '11111111111111111111111111111111' } })
    if (method === 'send_tx') { const bad = s.onSend?.(params.signed_tx_base64); return typeof bad === 'string' ? err('INVALID_TRANSACTION', bad) : ok({}) }
    if (method === 'tx') { const r = typeof s.txs === 'function' ? s.txs(params.tx_hash) : s.txs?.[params.tx_hash]; return r ? ok(r) : err('UNKNOWN_TRANSACTION') }
    return err('UNKNOWN_METHOD', method)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}
