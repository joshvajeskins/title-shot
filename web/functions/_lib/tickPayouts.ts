// Bell payouts: sign_payout with estimated fees, broadcast the stored raw tx, track it in KV, bump a stuck one,
// reset a signing request whose MPC callback never came back.
import { TGAS } from '../../src/game/chain/signer'
import type { RawPayout, RawSeason } from '../../src/game/chain/views'
import { getJson, putJson } from './cache'
import { estimateGas, getFeeHistory, getReceipt, sendRaw, txHashOf } from './evm'
import { bumpedFees, clampGas, feeParams, payoutValue } from './fees'
import { detailOf, type Log, type PayoutTrack, type TickDeps } from './tickTypes'

const STUCK_AFTER_MS = 10 * 60_000
const SIGN_RESET_AFTER_MS = 10 * 60_000 + 20_000 // contract SIGN_TIMEOUT is 10 min; the payout view has no timestamp, so we time it ourselves
const DUST_RECHECK_SEC = 3600
const FALLBACK_GAS = 60_000n // a recipient with code (EIP-7702 delegation) needs more than 21000

export const trackKey = (id: number) => `payout:${id}`
const feeKey = (id: number) => `payoutfee:${id}` // the fee cap and tip a payout was last signed with (the view has no tip)
const signingKey = (id: number) => `signing:${id}` // when this tick first saw the payout `signing`
const dustKey = (id: number) => `dust:${id}`

// A sign_payout that succeeds but returns no raw tx is a soft failure (the MPC callback failed and the contract cleared the
// signing flag). Retried with growing gaps (1, 2, 4, 8, 8 minutes), then given up after MAX_SIGN_ATTEMPTS attempts: logged as
// SIGN_GAVE_UP every tick until someone clears `signfail:<payout id>` in KV (scripts/reset-sign-payout.sh <id>).
export const signFailKey = (id: number) => `signfail:${id}`
export const MAX_SIGN_ATTEMPTS = 6
export const signBackoffMs = (failures: number): number => Math.min(8, 2 ** (failures - 1)) * 60_000
interface SignFail { n: number; next: number }

interface FeeParams { maxFee: bigint; priority: bigint; gas: bigint }

/** Sign one payout (or re-sign it with a higher fee). Returns false when it could not be signed. */
async function signOne(d: TickDeps, log: Log, beltId: number, p: RawPayout, purse: string, fee?: FeeParams): Promise<boolean> {
  if (!d.sponsor || !p.to) return false
  const kv = d.env.TS_KV
  const failed = await getJson<SignFail>(kv, signFailKey(p.id))
  if (failed && failed.n >= MAX_SIGN_ATTEMPTS) {
    log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: `SIGN_GAVE_UP after ${failed.n} attempts: clear KV ${signFailKey(p.id)} to retry` })
    return false
  }
  if (failed && d.now() < failed.next) return false // backing off: no call, no log
  if (!fee && (await getJson(kv, dustKey(p.id)))) return false // already reported; looked at again when the marker expires
  let params = fee
  if (!params) {
    const est = await estimateGas(d.base, { from: purse, to: p.to, value: 1n })
    const gas = clampGas(est ?? FALLBACK_GAS)
    const f = feeParams(await getFeeHistory(d.base))
    params = { maxFee: f.maxFee, priority: f.priority, gas }
  }
  if (payoutValue(BigInt(p.amount_wei), params.gas, params.maxFee) === null) {
    await putJson(kv, dustKey(p.id), 1, DUST_RECHECK_SEC) // logged once per hour, not on every tick
    log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: 'DUST: amount does not cover gas' })
    return false
  }
  const out = await d.sponsor.call(d.chain.id, 'sign_payout', {
    payout_id: p.id, max_fee_per_gas: params.maxFee.toString(), max_priority_fee_per_gas: params.priority.toString(), gas_limit: Number(params.gas),
  }, 150n * TGAS, 0n, 90_000)
  log({ belt: beltId, action: `sign_payout#${p.id}`, ok: !out.failure && typeof out.value === 'string', detail: detailOf(out) ?? `gas ${params.gas} maxFee ${params.maxFee}`, tx: out.hash })
  if (out.failure) return false
  if (typeof out.value !== 'string' || !out.value) {
    const n = (failed?.n ?? 0) + 1
    await putJson(kv, signFailKey(p.id), { n, next: d.now() + signBackoffMs(n) } satisfies SignFail, 7 * 86_400)
    log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: n >= MAX_SIGN_ATTEMPTS ? `SIGN_GAVE_UP after ${n} attempts: clear KV ${signFailKey(p.id)} to retry` : `SIGN_SOFT_FAIL attempt ${n}/${MAX_SIGN_ATTEMPTS}, next in ${signBackoffMs(n) / 60_000} min` })
    return false
  }
  if (failed) await kv.delete(signFailKey(p.id)).catch(() => undefined)
  await putJson(kv, feeKey(p.id), { maxFee: params.maxFee.toString(), priority: params.priority.toString() }, 7 * 86_400)
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
    await putJson(kv, trackKey(p.id), { hash: done.hash, status: done.status, at: d.now(), prior } satisfies PayoutTrack)
    log({ belt: beltId, action: `payout#${p.id}`, ok: done.status === 'mined', detail: done.status, tx: done.hash })
    return
  }
  if (tracked && tracked.hash === hash && d.now() - tracked.at > STUCK_AFTER_MS) {
    await bump(d, log, beltId, p, prior, hash)
    return
  }
  const sent = await sendRaw(d.base, raw)
  const at = tracked && tracked.hash === hash ? tracked.at : d.now()
  await putJson(kv, trackKey(p.id), { hash: sent.hash, status: 'sent', at, ...(prior.length ? { prior } : {}) } satisfies PayoutTrack)
  log({ belt: beltId, action: `broadcast#${p.id}`, ok: true, detail: sent.note, tx: sent.hash })
}

/**
 * Stuck tx: re-sign the same nonce with the fee cap AND the tip both 12.5% higher (nodes refuse a replacement unless both
 * rise 10%; the contract refuses unless the cap is strictly higher). The old hash stays tracked: it may still be mined.
 */
async function bump(d: TickDeps, log: Log, beltId: number, p: RawPayout, prior: string[], oldHash: string): Promise<void> {
  const kv = d.env.TS_KV
  // retry in another 10 minutes whatever happens below, and keep watching the tx we are replacing
  await putJson(kv, trackKey(p.id), { hash: oldHash, status: 'sent', at: d.now(), prior: [...new Set([...prior, oldHash])] } satisfies PayoutTrack)
  const prev = BigInt(p.max_fee_per_gas ?? '1')
  const saved = await getJson<{ maxFee: string; priority: string }>(kv, feeKey(p.id))
  const next = bumpedFees({ maxFee: prev, priority: saved && BigInt(saved.maxFee) === prev ? BigInt(saved.priority) : null })
  if (!next) { log({ belt: beltId, action: `bump#${p.id}`, ok: false, detail: 'fee already at the cap' }); return }
  const season = await d.chain.season(beltId, p.season_id)
  if (!season?.purse.address) return
  await signOne(d, log, beltId, p, season.purse.address, { ...next, gas: BigInt(p.gas_limit ?? 60_000) })
}

/** A payout `signing` for over 10 minutes lost its MPC callback: anyone may reset it so it can be signed again. */
async function resetIfLost(d: TickDeps, log: Log, beltId: number, p: RawPayout): Promise<void> {
  const kv = d.env.TS_KV
  const since = await getJson<number>(kv, signingKey(p.id))
  if (!since) { await putJson(kv, signingKey(p.id), d.now(), 3600); return }
  if (d.now() - since < SIGN_RESET_AFTER_MS || !d.sponsor) return
  const out = await d.sponsor.call(d.chain.id, 'reset_payout_signing', { id: p.id }, 30n * TGAS, 0n, 60_000)
  log({ belt: beltId, action: `reset_signing#${p.id}`, ok: !out.failure, detail: detailOf(out) ?? 'signing request lost: reset', tx: out.hash })
  if (!out.failure) await putJson(kv, signingKey(p.id), null)
}

/** All payouts of a closed season, one pass. Idempotent: every action is guarded by the contract's own state. */
export async function payoutsStep(d: TickDeps, log: Log, beltId: number, season: RawSeason): Promise<void> {
  if (season.state !== 'Closed' || !season.payouts.length) return
  const purse = season.purse.address
  const payouts = await d.chain.payouts(beltId, season.id)
  for (const p of payouts) {
    if (!p.to) continue // claimable: the payee registers an address with claim_payout
    if (BigInt(p.amount_wei) === 0n) continue
    if (p.signing) { await resetIfLost(d, log, beltId, p); continue } // the MPC signer is still answering (or lost the request)
    if (await getJson(d.env.TS_KV, signingKey(p.id))) await putJson(d.env.TS_KV, signingKey(p.id), null)
    const tracked = await getJson<PayoutTrack>(d.env.TS_KV, trackKey(p.id))
    if (p.raw_tx) { await broadcast(d, log, beltId, p, tracked); continue }
    if (!purse) { log({ belt: beltId, action: `sign_payout#${p.id}`, ok: false, detail: 'E_NO_ADDRESS: purse address not set yet' }); continue }
    await signOne(d, log, beltId, p, purse)
  }
}
