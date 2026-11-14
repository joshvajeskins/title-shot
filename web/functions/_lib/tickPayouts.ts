// Bell payouts: claim Vance's own payouts, sign_payout with estimated fees, broadcast the stored raw tx, track it in KV,
// bump a stuck one, reset a signing request whose MPC callback never came back.
import { TGAS, type Signer } from '../../src/game/chain/signer'
import type { RawPayout, RawSeason } from '../../src/game/chain/views'
import { getJson, putJson, scoped } from './cache'
import { deriveEvmAddress, estimateGas, getFeeHistory, getReceipt, sendRaw, txHashOf } from './evm'
import { bumpedFees, clampGas, feeParams, payoutValue, strangerFees } from './fees'
import { VANCE_PATH } from './purse'
import { detailOf, tickKey, type Log, type PayoutTrack, type TickDeps } from './tickTypes'

const STUCK_AFTER_MS = 10 * 60_000
const SIGN_RESET_AFTER_MS = 10 * 60_000 + 20_000 // contract SIGN_TIMEOUT is 10 min; the payout view has no timestamp, so we time it ourselves
const DUST_RECHECK_SEC = 3600
const FALLBACK_GAS = 60_000n // a recipient with code (EIP-7702 delegation) needs more than 21000

/** KV keys are scoped to the contract: payout ids restart at 1 on every new contract. */
export const trackKey = (contract: string, id: number) => scoped(contract, `payout:${id}`)
const feeKey = (d: TickDeps, id: number) => tickKey(d, `payoutfee:${id}`) // the fee cap and tip a payout was last signed with (the view has no tip)
const signingKey = (d: TickDeps, id: number) => tickKey(d, `signing:${id}`) // when this tick first saw the payout `signing`
const dustKey = (d: TickDeps, id: number) => tickKey(d, `dust:${id}`)

// A sign_payout that succeeds but returns no raw tx is a soft failure (the MPC callback failed and the contract cleared the
// signing flag). Retried with growing gaps (1, 2, 4, 8, 8 minutes), then given up after MAX_SIGN_ATTEMPTS attempts: logged as
// SIGN_GAVE_UP every tick until someone clears `<contract>:signfail:<payout id>` in KV (scripts/reset-sign-payout.sh <id>).
export const signFailKey = (contract: string, id: number) => scoped(contract, `signfail:${id}`)
export const MAX_SIGN_ATTEMPTS = 6
export const signBackoffMs = (failures: number): number => Math.min(8, 2 ** (failures - 1)) * 60_000
interface SignFail { n: number; next: number }

interface FeeParams { maxFee: bigint; priority: bigint; gas: bigint }

/** Vance signs its own payouts as the payee (its parameters are used as given); everything else is signed by the sponsor,
 *  a stranger to the contract, whose fee cap the contract lowers to a 1% gas burn. */
function signerFor(d: TickDeps, p: RawPayout): { signer: Signer | null; byPayee: boolean } {
  if (d.vance && p.payee === d.vance.accountId) return { signer: d.vance, byPayee: true }
  return { signer: d.sponsor, byPayee: false }
}

/** The fees the contract will actually sign with (`clamp_stranger_fee` for a non-payee). */
function effective(p: RawPayout, byPayee: boolean, f: FeeParams): FeeParams {
  return byPayee ? f : { ...strangerFees(BigInt(p.amount_wei), f.gas, f.maxFee, f.priority), gas: f.gas }
}

/** Sign one payout (or re-sign it with a higher fee). Returns false when it could not be signed. */
async function signOne(d: TickDeps, log: Log, beltId: number, p: RawPayout, purse: string, fee?: FeeParams): Promise<boolean> {
  const { signer, byPayee } = signerFor(d, p)
  if (!signer || !p.to) return false
  const kv = d.env.TS_KV
  const failKey = signFailKey(d.chain.id, p.id)
  const failed = await getJson<SignFail>(kv, failKey)
  if (failed && failed.n >= MAX_SIGN_ATTEMPTS) {
    log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: `SIGN_GAVE_UP after ${failed.n} attempts: clear KV ${failKey} to retry` })
    return false
  }
  if (failed && d.now() < failed.next) return false // backing off: no call, no log
  if (!fee && (await getJson(kv, dustKey(d, p.id)))) return false // already reported; looked at again when the marker expires
  let requested = fee
  if (!requested) {
    const est = await estimateGas(d.base, { from: purse, to: p.to, value: 1n })
    const gas = clampGas(est ?? FALLBACK_GAS)
    const f = feeParams(await getFeeHistory(d.base))
    requested = { maxFee: f.maxFee, priority: f.priority, gas }
  }
  const params = effective(p, byPayee, requested)
  if (payoutValue(BigInt(p.amount_wei), params.gas, params.maxFee) === null) {
    await putJson(kv, dustKey(d, p.id), 1, DUST_RECHECK_SEC) // logged once per hour, not on every tick
    log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: 'DUST: amount does not cover gas' })
    return false
  }
  const out = await signer.call(d.chain.id, 'sign_payout', {
    payout_id: p.id, max_fee_per_gas: requested.maxFee.toString(), max_priority_fee_per_gas: requested.priority.toString(), gas_limit: Number(requested.gas),
  }, 150n * TGAS, 0n, 90_000)
  log({ belt: beltId, action: `sign_payout#${p.id}`, ok: !out.failure && typeof out.value === 'string', detail: detailOf(out) ?? `gas ${params.gas} maxFee ${params.maxFee}`, tx: out.hash })
  if (out.failure) return false
  if (typeof out.value !== 'string' || !out.value) {
    const n = (failed?.n ?? 0) + 1
    await putJson(kv, failKey, { n, next: d.now() + signBackoffMs(n) } satisfies SignFail, 7 * 86_400)
    log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: n >= MAX_SIGN_ATTEMPTS ? `SIGN_GAVE_UP after ${n} attempts: clear KV ${failKey} to retry` : `SIGN_SOFT_FAIL attempt ${n}/${MAX_SIGN_ATTEMPTS}, next in ${signBackoffMs(n) / 60_000} min` })
    return false
  }
  if (failed) await kv.delete(failKey).catch(() => undefined)
  // the values the contract signed with (clamped for a stranger), so a later bump starts from what is really on the tx
  await putJson(kv, feeKey(d, p.id), { maxFee: params.maxFee.toString(), priority: params.priority.toString() }, 7 * 86_400)
  return true
}

/** Receipts for the latest broadcast and every earlier one (a pre-bump tx can still be the one that lands). */
async function minedOne(d: TickDeps, hashes: string[]): Promise<{ hash: string; status: 'mined' | 'reverted' } | null> {
  for (const h of hashes) {
    const r = await getReceipt(d.base, h).catch(() => null)
    if (r) return { hash: h, status: r.status === '0x1' ? 'mined' : 'reverted' }
  }
  return null
}

/** Broadcast a signed payout once; record its hash and status in KV. */
async function broadcast(d: TickDeps, log: Log, beltId: number, p: RawPayout, tracked: PayoutTrack | null): Promise<void> {
  const kv = d.env.TS_KV
  const raw = p.raw_tx!
  const hash = txHashOf(raw)
  if (tracked && tracked.status !== 'sent') return // terminal: mined or reverted
  const prior = [...new Set([...(tracked?.prior ?? []), ...(tracked && tracked.hash !== hash ? [tracked.hash] : [])])].filter((h) => h !== hash)
  const done = await minedOne(d, [hash, ...prior])
  if (done) {
    await putJson(kv, trackKey(d.chain.id, p.id), { hash: done.hash, status: done.status, at: d.now(), prior } satisfies PayoutTrack)
    log({ belt: beltId, action: `payout#${p.id}`, ok: done.status === 'mined', detail: done.status, tx: done.hash })
    return
  }
  if (tracked && tracked.hash === hash && d.now() - tracked.at > STUCK_AFTER_MS) {
    await bump(d, log, beltId, p, prior, hash)
    return
  }
  const sent = await sendRaw(d.base, raw)
  const at = tracked && tracked.hash === hash ? tracked.at : d.now()
  await putJson(kv, trackKey(d.chain.id, p.id), { hash: sent.hash, status: 'sent', at, ...(prior.length ? { prior } : {}) } satisfies PayoutTrack)
  log({ belt: beltId, action: `broadcast#${p.id}`, ok: true, detail: sent.note, tx: sent.hash })
}

/**
 * Stuck tx: re-sign the same nonce with the fee cap AND the tip both 12.5% higher (nodes refuse a replacement unless both
 * rise 10%; the contract refuses unless the cap is strictly higher). The old hash stays tracked: it may still be mined.
 * A stranger's cap is clamped by the contract: once it sits at that 1% cap, a bump would change nothing (STRANGER_CAP).
 */
async function bump(d: TickDeps, log: Log, beltId: number, p: RawPayout, prior: string[], oldHash: string): Promise<void> {
  const kv = d.env.TS_KV
  // retry in another 10 minutes whatever happens below, and keep watching the tx we are replacing
  await putJson(kv, trackKey(d.chain.id, p.id), { hash: oldHash, status: 'sent', at: d.now(), prior: [...new Set([...prior, oldHash])] } satisfies PayoutTrack)
  const prev = BigInt(p.max_fee_per_gas ?? '1')
  const saved = await getJson<{ maxFee: string; priority: string }>(kv, feeKey(d, p.id))
  const next = bumpedFees({ maxFee: prev, priority: saved && BigInt(saved.maxFee) === prev ? BigInt(saved.priority) : null })
  if (!next) { log({ belt: beltId, action: `bump#${p.id}`, ok: false, detail: 'fee already at the cap' }); return }
  const gas = BigInt(p.gas_limit ?? 60_000)
  if (effective(p, signerFor(d, p).byPayee, { ...next, gas }).maxFee <= prev) {
    log({ belt: beltId, action: `bump#${p.id}`, ok: false, detail: `STRANGER_CAP: the contract caps a non-payee's gas at 1% of the payout; ${p.payee} can re-sign it with higher fees` })
    return
  }
  const season = await d.chain.season(beltId, p.season_id)
  if (!season?.purse.address) return
  await signOne(d, log, beltId, p, season.purse.address, { ...next, gas })
}

/** A payout `signing` for over 10 minutes lost its MPC callback: anyone may reset it so it can be signed again. */
async function resetIfLost(d: TickDeps, log: Log, beltId: number, p: RawPayout): Promise<void> {
  const kv = d.env.TS_KV
  const since = await getJson<number>(kv, signingKey(d, p.id))
  if (!since) { await putJson(kv, signingKey(d, p.id), d.now(), 3600); return }
  if (d.now() - since < SIGN_RESET_AFTER_MS || !d.sponsor) return
  const out = await d.sponsor.call(d.chain.id, 'reset_payout_signing', { id: p.id }, 30n * TGAS, 0n, 60_000)
  log({ belt: beltId, action: `reset_signing#${p.id}`, ok: !out.failure, detail: detailOf(out) ?? 'signing request lost: reset', tx: out.hash })
  if (!out.failure) await putJson(kv, signingKey(d, p.id), null)
}

/** A payout to Vance with no address (e.g. the promoter refund of a season nobody challenged): Vance claims it to its own
 *  Chain-Signatures address, so the ETH goes back to the wallet that funds the next purse. Returns the address, or null. */
async function claimForVance(d: TickDeps, log: Log, beltId: number, p: RawPayout): Promise<string | null> {
  const vance = d.vance!
  const addr = await deriveEvmAddress(d.near, d.mpc, VANCE_PATH, vance.accountId)
  const out = await vance.call(d.chain.id, 'claim_payout', { payout_id: p.id, addr }, 30n * TGAS, 1n)
  log({ belt: beltId, action: `claim_payout#${p.id}`, ok: !out.failure, detail: detailOf(out) ?? addr, tx: out.hash })
  return out.failure ? null : addr
}

/** All payouts of a closed season, one pass. Idempotent: every action is guarded by the contract's own state. */
export async function payoutsStep(d: TickDeps, log: Log, beltId: number, season: RawSeason): Promise<void> {
  if (season.state !== 'Closed' || !season.payouts.length) return
  const purse = season.purse.address
  const payouts = await d.chain.payouts(beltId, season.id)
  for (let p of payouts) {
    if (BigInt(p.amount_wei) === 0n) continue
    if (!p.to) {
      if (!d.vance || p.payee !== d.vance.accountId) continue // claimable: the payee registers an address with claim_payout
      const to = await claimForVance(d, log, beltId, p)
      if (!to) continue
      p = { ...p, to }
    }
    if (p.signing) { await resetIfLost(d, log, beltId, p); continue } // the MPC signer is still answering (or lost the request)
    if (await getJson(d.env.TS_KV, signingKey(d, p.id))) await putJson(d.env.TS_KV, signingKey(d, p.id), null)
    const tracked = await getJson<PayoutTrack>(d.env.TS_KV, trackKey(d.chain.id, p.id))
    if (p.raw_tx) { await broadcast(d, log, beltId, p, tracked); continue }
    if (!purse) { log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: 'E_NO_ADDRESS: purse address not set yet' }); continue }
    await signOne(d, log, beltId, p, purse)
  }
}
