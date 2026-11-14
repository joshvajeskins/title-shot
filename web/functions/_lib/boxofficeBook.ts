// Box office, NEAR leg: once a Base payment is settled, credit the payer's corner with one toll (the sponsor fronts testnet
// NEAR at a fixed rate) and send `challenge` with the corner's function-call key. Every step is recorded in the payment's
// KV record before the next one, so a retried request resumes where the last one stopped and never books twice.
import { challengeGas } from '../../src/game/chain/config'
import { formatPublicKey } from '../../src/game/chain/keys'
import { contractCode, parseOutcome, RpcError, RpcUnavailable, type Rpc } from '../../src/game/chain/rpc'
import { NEAR, TGAS } from '../../src/game/chain/signer'
import { fn, signTransaction } from '../../src/game/chain/tx'
import type { RawChallenge } from '../../src/game/chain/views'
import { getJson, putJson, putJsonStrict, scoped } from './cache'
import type { KVLike } from './env'
import { ensureGuest, rotateSession, sessionKey, type BoxGuest, type GuestCtx } from './boxofficeGuest'
import { serialize } from './lane'

export type PayStatus = 'settling' | 'settled' | 'booked'
export interface PayRecord {
  id: string; status: PayStatus; payer: string; belt: number; sentence: string; at: number; attempt: string
  settleTx?: string | null; guest?: string; credited?: boolean; depositTx?: string; challengeTx?: string
  challengeId?: number; nearTx?: string | null; bookedAt?: number; error?: string
  /** nonce and session-key index the recorded `challengeTx` was signed with (a lost tx is resent at the same nonce) */
  challengeNonce?: string; challengeKey?: number
  /** the payer's primary Basename at booking time (null: none or not reachable) */
  payerName?: string | null
}
export const RECORD_SEC = 30 * 86_400
export const recKey = (contract: string, id: string) => scoped(contract, `boxoffice:pay:${id}`)

/** A booking step that did not complete. `pending`: its outcome is not known yet (a retry looks it up, never resends). */
export class BookingError extends Error {
  constructor(readonly code: string, message: string, readonly pending = false) { super(message) }
}

export interface BookCtx {
  g: GuestCtx; kv: KVLike; key: string; sleep: (ms: number) => Promise<void>; pollMs?: number; resolveMs?: number
  /** the contract's forge mode (`get_config.forge_mode`): it sets the gas `challenge` attaches (challengeGas) */
  forgeMode: string
}

const persist = async (c: BookCtx, r: PayRecord): Promise<PayRecord> => { await putJsonStrict(c.kv, c.key, r, RECORD_SEC); return r }

/** Credit one toll to the corner with `deposit_for` from the sponsor (the payment that created the corner already did). */
async function credit(c: BookCtx, r: PayRecord, account: string): Promise<PayRecord> {
  const sponsor = c.g.sponsor
  if (r.depositTx) {
    const out = await sponsor.wait(r.depositTx, 45_000).catch(() => null)
    if (!out) throw new BookingError('BOOKING_PENDING', 'Your toll credit is still confirming on NEAR.', true)
    if (!out.failure) return persist(c, { ...r, credited: true })
    r = await persist(c, { ...r, depositTx: undefined }) // it failed: nothing was credited, send it again
  }
  const balance = await c.g.near.balance(sponsor.accountId).catch(() => 0n)
  const floor = BigInt(Math.round(c.g.floorNear * 1e6)) * (NEAR / 1_000_000n)
  if (balance < floor + c.g.toll) throw new BookingError('SPONSOR_DRY', 'The house cannot front the toll right now.')
  const hash = await serialize('sponsor-guest', () => sponsor.send(c.g.contract, [fn('deposit_for', { account }, 30n * TGAS, c.g.toll)]))
  r = await persist(c, { ...r, depositTx: hash })
  const out = await sponsor.wait(hash, 60_000).catch(() => null)
  if (!out) throw new BookingError('BOOKING_PENDING', 'Your toll credit is still confirming on NEAR.', true)
  if (out.failure) {
    await persist(c, { ...r, depositTx: undefined })
    throw new BookingError(contractCode(out.failure) ?? 'DEPOSIT_FAILED', 'The house could not credit your toll on NEAR.')
  }
  return persist(c, { ...r, credited: true })
}

/** Learn what a sent `challenge` did: its id (from `get_pending` or the tx result), a contract refusal code, or unknown. */
export async function resolveChallenge(near: Rpc, contract: string, account: string, hash: string, sentence: string, sleep: (ms: number) => Promise<void>, totalMs = 45_000, pollMs = 1500): Promise<{ id: number | null; code: string | null }> {
  const t0 = Date.now() // wall clock: a slow RPC (free-plan `tx` timeouts) must not stretch the window
  while (Date.now() - t0 <= totalMs) {
    const pend = await near.view<RawChallenge | null>(contract, 'get_pending', { account }).catch(() => null)
    if (pend && pend.sentence === sentence) return { id: pend.id, code: null }
    try {
      const out = parseOutcome(await near.txStatus(hash, account, 'INCLUDED'))
      if (out.failure) return { id: null, code: contractCode(out.failure) ?? 'E_TX_FAILED' }
      if (typeof out.value === 'number') return { id: out.value, code: null }
    } catch (e) {
      if (e instanceof RpcError && !/UNKNOWN_TRANSACTION|timeout/i.test(e.kind + e.message)) return { id: null, code: null }
    }
    await sleep(pollMs)
  }
  return { id: null, code: null }
}

const ALLOWANCE = /NotEnoughAllowance|allowance/i
class AllowanceOut extends Error {}

/**
 * Sign `challenge` with session key `index` at an explicit nonce, record hash and nonce BEFORE the broadcast, then send.
 * Nonces are per key and only this box office holds the key, so two signings at one nonce can never both land: that is
 * what makes a resend of a lost transaction safe.
 */
async function sendAt(c: BookCtx, r: PayRecord, guest: BoxGuest, index: number, nonce: bigint): Promise<PayRecord> {
  const key = sessionKey(c.g, r.payer, index)
  const tx = signTransaction({ signerId: guest.accountId, receiverId: c.g.contract, nonce, blockHash: await c.g.near.blockHash(), actions: [fn('challenge', { belt_id: r.belt, sentence: r.sentence }, challengeGas(c.forgeMode), 0n)] }, key)
  r = await persist(c, { ...r, challengeTx: tx.hash, challengeNonce: nonce.toString(), challengeKey: index })
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await c.g.near.sendAsync(tx.base64); return r } catch (e) {
      if (e instanceof RpcUnavailable) { await c.sleep(c.pollMs ?? 900); continue } // the same bytes again: deduplicated by hash
      const msg = e instanceof Error ? e.message : String(e)
      if (/InvalidNonce/.test(msg)) return r // the nonce is used: by this payment's earlier send, which resolve() picks up
      if (ALLOWANCE.test(msg)) throw new AllowanceOut()
      throw new BookingError('CHALLENGE_SEND_FAILED', 'Could not send your challenge to NEAR.')
    }
  }
  return r // unknown: resolve() and the nonce check decide
}

const keyNonce = (c: BookCtx, r: PayRecord, guest: BoxGuest, index: number): Promise<bigint> =>
  c.g.near.accessKeyNonce(guest.accountId, formatPublicKey(sessionKey(c.g, r.payer, index).publicKey))

/** First send of this payment's challenge (a fresh session key if the current one's gas allowance ran out). */
async function sendFirst(c: BookCtx, r: PayRecord, guest: BoxGuest): Promise<PayRecord> {
  try {
    return await sendAt(c, r, guest, guest.session, (await keyNonce(c, r, guest, guest.session)) + 1n)
  } catch (e) {
    if (!(e instanceof AllowanceOut)) throw e
    const g = await rotateSession(c.g, r.payer, guest)
    return sendAt(c, r, g, g.session, (await keyNonce(c, r, g, g.session)) + 1n)
  }
}

/** Send `challenge` (or pick up the one already sent for this payment) and return its id. */
async function challenge(c: BookCtx, r: PayRecord, guest: BoxGuest): Promise<PayRecord> {
  const contract = c.g.contract
  const account = guest.accountId
  const resumed = !!r.challengeTx
  if (!r.challengeTx) {
    const pend = await c.g.near.view<RawChallenge | null>(contract, 'get_pending', { account }).catch(() => null)
    if (pend) {
      // this payment's challenge landed but its hash was not recorded: adopt it; anything else is an earlier fight
      if (pend.sentence === r.sentence && pend.belt_id === r.belt) return persist(c, { ...r, status: 'booked', challengeId: pend.id, nearTx: null, bookedAt: c.g.now() })
      throw new BookingError('E_PENDING', 'Your corner already has a fight being forged. Wait for it to finish, then send the same request again.')
    }
    r = await sendFirst(c, r, guest).catch((e) => { throw e instanceof BookingError ? e : new BookingError('CHALLENGE_SEND_FAILED', 'Could not send your challenge to NEAR.') })
  }
  const full = c.resolveMs ?? 45_000
  for (let round = 0; round < 2; round++) {
    const window = round === 0 && resumed ? Math.min(full, 6_000) : full // a resumed request already waited once
    const res = await resolveChallenge(c.g.near, contract, account, r.challengeTx!, r.sentence, c.sleep, window, c.pollMs)
    if (res.id !== null) return persist(c, { ...r, status: 'booked', challengeId: res.id, nearTx: r.challengeTx, bookedAt: c.g.now() })
    if (res.code) {
      await persist(c, { ...r, challengeTx: undefined, challengeNonce: undefined, challengeKey: undefined }) // refused, no toll moved: a retry may send again
      throw new BookingError(res.code, 'The contract refused the challenge.')
    }
    if (round === 1 || r.challengeNonce === undefined || r.challengeKey === undefined) break
    // not seen: if the key's nonce is still below ours, nothing with our nonce landed; resend AT THE SAME NONCE (the lost tx and
    // the new one exclude each other), so a lost broadcast can never strand a paid booking nor book it twice
    const onChain = await keyNonce(c, r, guest, r.challengeKey).catch(() => null)
    if (onChain === null || onChain >= BigInt(r.challengeNonce)) break
    r = await sendAt(c, r, guest, r.challengeKey, BigInt(r.challengeNonce)).catch((e) => { throw e instanceof BookingError ? e : new BookingError('BOOKING_PENDING', 'Your challenge is still landing on NEAR.', true) })
  }
  throw new BookingError('BOOKING_PENDING', 'Your challenge is still landing on NEAR.', true)
}

/** The whole NEAR leg for a settled payment. Throws BookingError; the record keeps every step that completed. */
export async function book(c: BookCtx, r: PayRecord): Promise<PayRecord> {
  const { guest } = await ensureGuest(c.g, r.payer, r.id)
  if (r.guest !== guest.accountId) r = await persist(c, { ...r, guest: guest.accountId })
  if (!r.credited && guest.createdBy === r.id) r = await persist(c, { ...r, credited: true }) // the toll was the corner's first deposit
  if (!r.credited) r = await credit(c, r, guest.accountId)
  return challenge(c, r, guest)
}

// ---- recent box-office bookings (for the UI's "challenger from Base" badge)
export interface RecentBooking { challengeId: number; guest: string; payer: string; payerName: string | null; belt: number; settleTx: string | null; nearTx: string | null; at: number }
export const recentKey = (contract: string) => scoped(contract, 'boxoffice:recent')

export async function pushRecent(kv: KVLike, contract: string, r: PayRecord): Promise<void> {
  if (r.challengeId === undefined || !r.guest) return
  const list = (await getJson<RecentBooking[]>(kv, recentKey(contract))) ?? []
  if (list.some((x) => x.challengeId === r.challengeId)) return
  const item: RecentBooking = { challengeId: r.challengeId, guest: r.guest, payer: r.payer, payerName: r.payerName ?? null, belt: r.belt, settleTx: r.settleTx ?? null, nearTx: r.nearTx ?? null, at: r.bookedAt ?? 0 }
  await putJson(kv, recentKey(contract), [item, ...list].slice(0, 50))
}
