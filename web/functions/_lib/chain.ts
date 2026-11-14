// Server-side contract reads. Every upstream failure becomes a 502 { code: CHAIN_UNAVAILABLE }, never a raw RPC error.
import { Rpc, RpcError, RpcUnavailable } from '../../src/game/chain/rpc'
import type { RawBelt, RawChallenge, RawFight, RawFighter, RawPayout, RawSeason } from '../../src/game/chain/views'
import { DEFAULTS, list, type Env } from './env'
import { ApiError } from './http'

const fighterMem = new Map<string, { exp: number; value: RawFighter | null }>()

export function rpcFor(env: Env): Rpc {
  return new Rpc({ urls: list(env.NEAR_RPC_URLS) })
}

export function baseRpcFor(env: Env): Rpc {
  return new Rpc({ urls: list(env.BASE_RPC_URLS) ?? DEFAULTS.baseRpcs })
}

export const contractIdOf = (env: Env): string | null => (env.CONTRACT_ID ?? '').trim() || null

export interface ContractConfig {
  owner: string; outlayer: string; mpc_signer: string; model_id: string; signature_kind: string; forge_mode: 'outlayer' | 'relayer'
  relayers: string[]; belt_count: number; min_forge_fee: string; forge_timeout_sec: number
  prefix_sha256: string; suffix_sha256: string
}

export interface DeployGates { ok: boolean; ready: boolean; failing: { gate: string; why: string; blocking: boolean }[] }

export class Chain {
  readonly rpc: Rpc
  readonly id: string
  constructor(readonly env: Env, rpc?: Rpc) {
    const id = contractIdOf(env)
    if (!id) throw new ApiError(503, 'NOT_DEPLOYED', 'The game contract is not deployed yet.')
    this.id = id
    this.rpc = rpc ?? rpcFor(env)
  }

  async view<T>(method: string, args: unknown = {}): Promise<T> {
    try {
      return await this.rpc.view<T>(this.id, method, args)
    } catch (e) {
      if (e instanceof RpcError || e instanceof RpcUnavailable) throw new ApiError(502, 'CHAIN_UNAVAILABLE', 'The chain is not answering. Try again in a moment.')
      throw e
    }
  }

  config = () => this.view<ContractConfig>('get_config')
  belts = () => this.view<RawBelt[]>('get_belts')
  belt = (id: number) => this.view<RawBelt>('get_belt', { id })
  season = (beltId: number, seasonId: number) => this.view<RawSeason | null>('get_season', { belt_id: beltId, season_id: seasonId })
  challenge = (id: number) => this.view<RawChallenge | null>('get_challenge', { id })
  fight = (id: number) => this.view<RawFight | null>('get_fight', { id })
  fights = (beltId: number, from: number, limit: number) => this.view<RawFight[]>('get_fights', { belt_id: beltId, from, limit })
  payouts = (beltId: number, seasonId: number) => this.view<RawPayout[]>('get_payouts', { belt: beltId, season: seasonId })
  allowlist = () => this.view<{ active: string[]; pending: string[] | null }>('get_allowlist')
  stats = () => this.view<{ next_challenge_id: number; challenges: number }>('stats')
  fighterBySentence = (sentence: string) => this.view<RawFighter | null>('get_fighter_by_sentence', { sentence })
  /** Unmet deploy conditions; `ready: false` means `challenge` refuses every call with E_NOT_READY. */
  deployGates = () => this.view<DeployGates>('get_deploy_gates')

  /** Immutable per hash (only the record changes), so a 5 minute memory cache is plenty. */
  async fighter(hash: string, now = Date.now()): Promise<RawFighter | null> {
    const hit = fighterMem.get(hash)
    if (hit && hit.exp > now) return hit.value
    const value = await this.view<RawFighter | null>('get_fighter', { hash_hex: hash })
    fighterMem.set(hash, { exp: now + 5 * 60_000, value })
    return value
  }
}

export function clearFighterCache() { fighterMem.clear() }

/** Chain or null when the contract id is not configured (preview and static routes still work). */
export function maybeChain(env: Env): Chain | null {
  return contractIdOf(env) ? new Chain(env) : null
}
