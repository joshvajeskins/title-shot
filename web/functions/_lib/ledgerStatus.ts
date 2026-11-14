// The spend status /api/state shows: whether free previews (forge) and new portraits are open, why not, and what is left.
import type { Env } from './env'
import { Ledger, limitsOf, type ForgeStatus, type LedgerDeps } from './ledger'
import { PORTRAIT_MODEL } from './portraitGen'
import { toUsd } from './pricing'
import { isStandin } from './standin'

export interface ForgeState { forge: ForgeStatus; portraits: { open: boolean } }

export async function forgeStatus(env: Env, compileModel: string, d: LedgerDeps = {}): Promise<ForgeState> {
  const L = limitsOf(env)
  const ledger = Ledger.of(env, d)
  if (!ledger) {
    // no key: the stand-in referee compiles for free (staging), else nothing can compile or draw
    const open = isStandin(env)
    return {
      forge: { open, reason: open ? null : 'no_key', resetsAt: null, spentUsd: 0, budgetUsd: toUsd(L.budget), publicLeftUsd: open ? toUsd(Math.min(L.publicDaily, L.publicTotal, L.budget)) : 0 },
      portraits: { open: false },
    }
  }
  return ledger.status(compileModel, PORTRAIT_MODEL)
}
