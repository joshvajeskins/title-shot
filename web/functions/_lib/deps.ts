// Builds the tick's dependencies from the Pages environment. A missing role key just disables that role.
import { parseSecretKey } from '../../src/game/chain/keys'
import { Signer } from '../../src/game/chain/signer'
import type { Rpc } from '../../src/game/chain/rpc'
import type { Sim } from '../../src/sim'
import { baseRpcFor, Chain, rpcFor } from './chain'
import { DEFAULTS, type Env } from './env'
import type { TickDeps } from './tickTypes'

export function signerFrom(account: string, secret: string | undefined, rpc: Rpc): Signer | null {
  if (!secret) return null
  try { return new Signer(account, parseSecretKey(secret), rpc) } catch { return null }
}

export function tickDeps(env: Env, sim: Sim): TickDeps {
  const near = rpcFor(env)
  return {
    env, sim, near, base: baseRpcFor(env), chain: new Chain(env, near), fetchFn: (...a) => fetch(...a), now: () => Date.now(),
    mpc: env.MPC_SIGNER ?? DEFAULTS.mpcSigner,
    sponsor: signerFrom(env.SPONSOR_ID ?? DEFAULTS.sponsorId, env.SPONSOR_KEY, near),
    vance: signerFrom(env.VANCE_ID ?? DEFAULTS.vanceId, env.VANCE_KEY, near),
    relayer: signerFrom(env.RELAYER_ID ?? DEFAULTS.relayerId, env.RELAYER_KEY, near),
  }
}
