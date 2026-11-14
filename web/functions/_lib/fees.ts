// Payout fee and gas parameters for `sign_payout`, always inside the contract's bounds (economy::gas_params_ok).
import { GAS_LIMIT_MAX, GAS_LIMIT_MIN, MAX_FEE_CAP_WEI } from '../../src/game/chain/config'

const MIN_PRIORITY = 1_000_000n // 0.001 gwei

/** estimateGas + 20%, clamped to [21000, 150000]. */
export function clampGas(estimate: bigint): bigint {
  const padded = (estimate * 120n + 99n) / 100n
  return padded < GAS_LIMIT_MIN ? GAS_LIMIT_MIN : padded > GAS_LIMIT_MAX ? GAS_LIMIT_MAX : padded
}

export interface FeeHistory { baseFeePerGas: string[]; reward?: string[][] }

const median = (xs: bigint[]): bigint => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return s.length ? s[Math.floor(s.length / 2)]! : 0n
}

/** maxFee = 3 x next base fee + priority (survives minutes of base-fee drift); both clamped to the contract's bounds. */
export function feeParams(h: FeeHistory): { maxFee: bigint; priority: bigint } {
  const baseFees = (h.baseFeePerGas ?? []).map((x) => BigInt(x))
  const nextBase = baseFees.length ? baseFees[baseFees.length - 1]! : 0n
  const tips = (h.reward ?? []).map((r) => BigInt(r[0] ?? '0x0')).filter((t) => t > 0n)
  let priority = tips.length ? median(tips) : MIN_PRIORITY
  if (priority < MIN_PRIORITY) priority = MIN_PRIORITY
  let maxFee = nextBase * 3n + priority
  if (maxFee > MAX_FEE_CAP_WEI) maxFee = MAX_FEE_CAP_WEI
  if (maxFee < 1n) maxFee = 1n
  if (priority > maxFee) priority = maxFee
  return { maxFee, priority }
}

/** Mirror of the contract's payout_value: the payee pays gas out of the payout; null = dust (contract E_DUST). */
export function payoutValue(amountWei: bigint, gasLimit: bigint, maxFee: bigint): bigint | null {
  const v = amountWei - gasLimit * maxFee
  return v > 0n ? v : null
}

/** A signed tx must be re-signed with a strictly higher maxFee (contract E_FEE_NOT_HIGHER); bump at least 12.5%. */
export function bumpedFee(previous: bigint): bigint {
  const bumped = previous + previous / 8n + 1n
  return bumped > MAX_FEE_CAP_WEI ? MAX_FEE_CAP_WEI : bumped
}

/**
 * Replacement fees for a stuck same-nonce tx. Nodes only accept a replacement when BOTH the fee cap and the tip rise by at
 * least 10%, so each is raised 12.5%. `priority` is the tip the stuck tx was signed with; unknown -> the highest tip the
 * cap allows (the payee already accepted paying up to `maxFee * gas`). Returns null when the cap leaves no room.
 */
export function bumpedFees(prev: { maxFee: bigint; priority?: bigint | null }): { maxFee: bigint; priority: bigint } | null {
  const maxFee = bumpedFee(prev.maxFee)
  if (maxFee <= prev.maxFee) return null
  let priority = prev.priority && prev.priority > 0n ? prev.priority + prev.priority / 8n + 1n : maxFee
  if (priority > maxFee) priority = maxFee
  return { maxFee, priority }
}

/**
 * Mirror of the contract's `clamp_stranger_fee`: a caller who is not the payee gets `maxFee` lowered so the gas burn
 * (`gasLimit * maxFee`) stays within 1% of the payout (never below 1 wei), and the tip follows it down.
 */
export function strangerFees(amountWei: bigint, gasLimit: bigint, maxFee: bigint, priority: bigint): { maxFee: bigint; priority: bigint } {
  const cap = amountWei / 100n
  let allowed = cap / (gasLimit > 0n ? gasLimit : 1n)
  if (allowed < 1n) allowed = 1n
  const fee = maxFee < allowed ? maxFee : allowed
  return { maxFee: fee, priority: priority < fee ? priority : fee }
}
