// Contract error codes -> sentences a player can act on, and `get_challenge` -> forge progress.
import { GameError } from '../client'
import type { RawChallenge } from './views'

const NEAR = 10n ** 24n
export const formatNear = (yocto: bigint, digits = 2): string => {
  const scale = 10n ** BigInt(24 - digits)
  const rounded = (yocto + scale / 2n) / scale
  const whole = rounded / 10n ** BigInt(digits)
  const frac = (rounded % 10n ** BigInt(digits)).toString().padStart(digits, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export interface ErrorCtx { toll?: bigint; balance?: bigint }

const MESSAGES: Record<string, (c: ErrorCtx) => string> = {
  E_BALANCE: (c) => (c.toll !== undefined
    ? `Top up: you need ${formatNear(c.toll)} NEAR for the toll${c.balance !== undefined ? ` and have ${formatNear(c.balance)}` : ''}.`
    : 'Your balance is too low for the toll. Top up and try again.'),
  E_PENDING: () => 'You already have a fight being forged. Wait for it to finish.',
  E_SELF: () => 'You hold this belt. You cannot challenge yourself.',
  E_SAME_SENTENCE: () => 'That is the champion\'s own sentence. Write a different one.',
  E_SENTENCE: () => 'The sentence must be 3 to 120 characters with no control characters.',
  E_NO_SEASON: () => 'This belt has no open season right now. The bell is ringing or the promoter is warming up.',
  E_NO_CHAMPION: () => 'This belt has no champion yet. The promoter is still forging the opener.',
  E_NO_BELT: () => 'That belt does not exist.',
  E_STORAGE: () => 'The first deposit must cover account storage (0.005 NEAR).',
  E_TOO_EARLY: () => 'Too early. The bell has not rung yet.',
  E_CLOSED: () => 'This season is already closed.',
  E_AI_SIG: () => 'The AI signature did not verify, so the forge was refunded.',
  E_REFUSED: () => 'The referee refused this sentence. Your toll was refunded minus the forge fee.',
  E_FORGE_FAILED: () => 'The forge failed. Your toll was refunded minus the forge fee.',
  E_FORGE_OUTPUT: () => 'The forge returned something unreadable. Your toll was refunded minus the forge fee.',
  E_TIMEOUT: () => 'The forge timed out. Your toll was refunded minus the forge fee.',
  E_VRF: () => 'The randomness proof did not verify. Your toll was refunded minus the forge fee.',
  E_BAD_SENTENCE: () => 'The sentence must be 3 to 120 characters with no control characters.',
  E_UNKNOWN_MOVE: () => 'The AI picked a move that is not in the rulebook, so the fighter was rejected.',
  E_DUP_MOVE: () => 'The AI repeated a move, so the fighter was rejected.',
  E_BAD_STATS: () => 'The fighter broke the 100-point budget, so it was rejected.',
  E_STATE: () => 'The belt changed while your fight was forging. Your toll was refunded minus the forge fee.',
}

/**
 * Codes that mean one thing when the challenge transaction itself is refused (nothing was charged) and another once the
 * forge has run: then the rejection is a refund, so the player is told their toll came back.
 */
const REFUND_MESSAGES: Record<string, () => string> = {
  E_SELF: () => 'The belt changed hands while your fighter was forging; your toll came back minus the forge fee.',
  E_CLOSED: () => 'The season closed while your fighter was forging; your toll came back minus the forge fee.',
}

/** The message for a challenge that failed after forging (status Rejected or Refunded). */
export function refundMessageFor(code: string | null | undefined, ctx: ErrorCtx = {}): string {
  const m = code ? REFUND_MESSAGES[code] : undefined
  return m ? m() : messageFor(code, ctx)
}

export function messageFor(code: string | null | undefined, ctx: ErrorCtx = {}): string {
  if (!code) return 'Something went wrong. Try again.'
  const m = MESSAGES[code]
  return m ? m(ctx) : `The contract refused: ${code}.`
}

export function gameErrorFor(code: string | null | undefined, ctx: ErrorCtx = {}): GameError {
  return new GameError(code ?? 'E_UNKNOWN', messageFor(code, ctx))
}

/** A transport-level failure (network, RPC) as a GameError. */
export function networkError(e: unknown): GameError {
  if (e instanceof GameError) return e
  const msg = e instanceof Error ? e.message : String(e)
  return new GameError('E_NETWORK', /timeout/i.test(msg) ? 'The network is slow right now. Try again in a moment.' : 'Could not reach the chain. Check your connection and try again.')
}

export type ChallengePhase =
  | { phase: 'forging' }
  | { phase: 'resolved'; fightId: number | null }
  | { phase: 'failed'; code: string; message: string; refunded: boolean }

/** Map a `get_challenge` view to what the UI should show next. */
export function describeChallenge(c: RawChallenge | null, ctx: ErrorCtx = {}): ChallengePhase {
  if (!c) return { phase: 'forging' }
  switch (c.status) {
    case 'Forging':
      return { phase: 'forging' }
    case 'Resolved':
      return { phase: 'resolved', fightId: c.fight_id }
    case 'Rejected':
    case 'Refunded': {
      const code = c.code ?? 'E_FORGE_FAILED'
      return { phase: 'failed', code, message: refundMessageFor(code, ctx), refunded: true }
    }
    default:
      return { phase: 'forging' }
  }
}

export { NEAR }
