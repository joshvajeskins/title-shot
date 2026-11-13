// Shared types for the promoter/bell tick.
import type { Rpc } from '../../src/game/chain/rpc'
import type { Signer } from '../../src/game/chain/signer'
import type { Sim } from '../../src/sim'
import type { Chain } from './chain'
import type { Env } from './env'

export interface StepLog { belt?: number; action: string; ok: boolean; detail?: string; tx?: string }
export interface TickLog { at: number; ms: number; steps: StepLog[]; skipped?: string }

export interface TickDeps {
  env: Env
  sim: Sim
  chain: Chain
  near: Rpc
  base: Rpc
  sponsor: Signer | null
  vance: Signer | null
  relayer: Signer | null
  fetchFn: typeof fetch
  now: () => number
  mpc: string
}

export type Log = (s: StepLog) => void

/** Contract call outcome -> a short log detail with the stable E_ code when there is one. */
export function detailOf(out: { failure: string | null }): string | undefined {
  if (!out.failure) return undefined
  const m = /E_[A-Z_]+/.exec(out.failure)
  return m ? m[0] : out.failure.slice(0, 100)
}

/** `hash` is the latest broadcast; `prior` are the hashes of earlier broadcasts of the same payout (before fee bumps):
 *  any of them may be the one that gets mined, so every receipt is checked. */
export interface PayoutTrack { hash: string; status: 'sent' | 'mined' | 'reverted'; at: number; raw?: string; prior?: string[] }

/**
 * What the public /api/state shows of a tick step. Exception text (from `safe()` and the top-level catch) never leaves the
 * server on a failed step: only a stable code such as E_NO_ADDRESS, DUST or VANCE_DRY, else the word "error". Successful
 * steps carry our own text (amounts, the opener sentence), which is fine. The full log stays in KV and behind the tick secret.
 */
export function publicDetail(step: StepLog): string | undefined {
  if (!step.detail) return undefined
  if (step.ok) return step.detail.slice(0, 140)
  const code = /^[A-Z][A-Z0-9_]{2,}/.exec(step.detail)
  return code ? code[0] : 'error'
}

export function publicTick(t: TickLog | null): TickLog | null {
  if (!t) return null
  return { ...t, steps: t.steps.map((s) => ({ ...s, ...(s.detail ? { detail: publicDetail(s) } : {}) })) }
}
