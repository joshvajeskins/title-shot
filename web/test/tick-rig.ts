// Scripted world for the promoter tick: a fake contract, signers and Base Sepolia RPC.
import { env, MemKV, mpcSign, sim, TEST_DERIVED_KEY } from './helpers'
import { belt, CONTRACT, NOW_MS, ns } from './fixtures'
import { checkArgs } from './contract-abi'
import { txHashOf } from '../functions/_lib/evm'
import { runTick } from '../functions/_lib/tick'
import type { TickDeps } from '../functions/_lib/tickTypes'
import type { RawBelt, RawChallenge, RawPayout, RawSeason } from '../src/game/chain/views'
import type { Signer } from '../src/game/chain/signer'

export interface Call { who: string; receiver: string; method: string; args: any; deposit: bigint }
export interface World {
  belts: RawBelt[]; payouts: Record<string, RawPayout[]>; seasons: Record<string, RawSeason | null>; challenges: Record<number, RawChallenge>; nextChallenge: number
  forgeMode: 'outlayer' | 'relayer'; failures: Record<string, string>; receipts: Record<string, { status: string } | null>; baseBalance: bigint; broadcastError: string | null
  now: number; autoMine: boolean
  /** sign_payout succeeds but the MPC callback failed: the call returns null instead of the raw tx */
  softSign: boolean
}
export const world = (over: Partial<World> = {}): World => ({ belts: [belt()], payouts: {}, seasons: {}, challenges: {}, nextChallenge: 0, forgeMode: 'outlayer', failures: {}, receipts: {}, baseBalance: 10n ** 16n, broadcastError: null, now: NOW_MS, autoMine: false, softSign: false, ...over })

export function setup(w: World, opts: { sponsor?: boolean; vance?: boolean; relayer?: boolean; fetchFn?: typeof fetch } = {}) {
  const calls: Call[] = []
  const sent: string[] = []
  const kv = new MemKV()
  const signer = (id: string): Signer => {
    const pending = new Map<string, any>()
    const s = {
      accountId: id,
      call: async (receiver: string, method: string, args: any, _gas: bigint, deposit = 0n) => {
        checkArgs(method, args)
        calls.push({ who: id, receiver, method, args, deposit })
        const failure = w.failures[method] ?? null
        const value = method === 'sign_payout' && !failure && !w.softSign ? '0x02' + 'ab'.repeat(40) : null
        return { hash: `tx-${calls.length}`, failure, value, logs: [], events: [], status: 'SuccessValue', raw: {} }
      },
      send: async (receiver: string, actions: any[]) => { const h = `mpc-${pending.size}`; pending.set(h, JSON.parse(new TextDecoder().decode(actions[0].args))); calls.push({ who: id, receiver, method: actions[0].method, args: pending.get(h), deposit: actions[0].deposit }); return h },
      wait: async (h: string) => ({ failure: null, value: mpcSign(pending.get(h).request.payload_v2.Ecdsa), logs: [], events: [], status: 'SuccessValue', raw: {} }),
    }
    return s as unknown as Signer
  }
  const chain = {
    id: CONTRACT,
    belts: async () => w.belts,
    payouts: async (b: number, s: number) => w.payouts[`${b}:${s}`] ?? [],
    season: async (b: number, s: number) => w.seasons[`${b}:${s}`] ?? null,
    challenge: async (id: number) => w.challenges[id] ?? null,
    stats: async () => ({ next_challenge_id: w.nextChallenge, challenges: w.nextChallenge }),
    config: async () => ({ model_id: 'Qwen/Qwen3.8-27B', forge_mode: w.forgeMode }),
  }
  const near = { view: async (_c: string, m: string) => { if (m === 'derived_public_key') return TEST_DERIVED_KEY; throw new Error('no view ' + m) }, balance: async () => 10n ** 24n }
  const base = {
    call: async (method: string, params: any[]) => {
      switch (method) {
        case 'eth_estimateGas': return '0x5208' // 21000
        case 'eth_feeHistory': return { baseFeePerGas: ['0x5f5e100', '0x5f5e100', '0x5f5e100', '0x5f5e100', '0x5f5e100', '0x5f5e100'], reward: [['0x186a0'], ['0x186a0'], ['0x186a0'], ['0x186a0'], ['0x186a0']] }
        case 'eth_getBalance': return '0x' + w.baseBalance.toString(16)
        case 'eth_getTransactionCount': return '0x3'
        case 'eth_getTransactionReceipt': return w.receipts[params[0]] ?? null
        case 'eth_sendRawTransaction': if (w.broadcastError) throw new Error(w.broadcastError); sent.push(params[0]); if (w.autoMine) w.receipts[txHashOf(params[0])] = { status: '0x1' }; return '0x' + 'aa'.repeat(32)
        default: throw new Error('no eth method ' + method)
      }
    },
  }
  const d = {
    env: env({ PURSE_WEI: '2000000000000000', SEASON_SEC: '3600' }), sim: sim(), chain, near, base,
    sponsor: opts.sponsor === false ? null : signer('play.titleshot.testnet'), vance: opts.vance === false ? null : signer('vance.titleshot.testnet'), relayer: opts.relayer ? signer('relay.titleshot.testnet') : null,
    fetchFn: opts.fetchFn ?? ((async () => new Response('no network in tests', { status: 500 })) as unknown as typeof fetch), now: () => w.now, mpc: 'v1.signer-prod.testnet',
  } as unknown as TickDeps
  d.env.TS_KV = kv
  return { d, calls, sent, kv }
}
export const run = (d: TickDeps) => runTick(d, { force: true })
export const methods = (calls: Call[]) => calls.map((c) => c.method)
export const later = (s: RawSeason | null, ms: number) => (s ? { ...s, closes_at: ns(NOW_MS - ms) } : null)

