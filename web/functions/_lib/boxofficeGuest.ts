// Box-office corners: one NEAR guest account per Base payer, created through the shared guest flow (guest.ts createGuest)
// and remembered in KV by the payer's address. The house holds the keys (custodial, testnet): they are derived from a
// server secret per payer, so nothing secret is ever stored in KV and a lost record re-derives the same keys.
import { ed25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8 } from '../../src/game/chain/bytes'
import { formatPublicKey, type KeyPair } from '../../src/game/chain/keys'
import type { Rpc } from '../../src/game/chain/rpc'
import { Signer, TGAS } from '../../src/game/chain/signer'
import { getJson, putJsonStrict, scoped } from './cache'
import type { KVLike } from './env'
import { createGuest, sessionAllowance } from './guest'
import { ApiError } from './http'
import { serialize } from './lane'

/** The contract keeps 0.005 NEAR of an account's first deposit for storage (contract/src/util.rs ACCOUNT_STORAGE). */
export const ACCOUNT_STORAGE = 5_000_000_000_000_000_000_000n

export interface BoxGuest {
  accountId: string
  /** index of the current `challenge`-only session key (a new one is added when the allowance runs out) */
  session: number
  /** the payer's Base address is registered with `set_evm_address`, so purses this corner wins pay out there */
  evmSet: boolean
  /** the payment whose toll was this account's first deposit */
  createdBy: string
  at: number
}

export interface GuestCtx {
  near: Rpc; sponsor: Signer; contract: string; kv: KVLike; seed: string
  toll: bigint; gas: bigint; floorNear: number; now: () => number
}

export const mapKey = (contract: string, addr: string) => scoped(contract, `boxoffice:evm:${addr.toLowerCase()}`)

/** HMAC-SHA256(seed, label) as an ed25519 seed. Labels are per contract, payer and role ("full", "session:<n>"). */
export function deriveKey(seed: string, contract: string, addr: string, role: string): KeyPair {
  const s = hmac(sha256, utf8(seed), utf8(`titleshot-boxoffice:v1:${contract}:${addr.toLowerCase()}:${role}`))
  return { seed: s, publicKey: ed25519.getPublicKey(s) }
}

export const findGuest = (kv: KVLike, contract: string, addr: string): Promise<BoxGuest | null> => getJson<BoxGuest>(kv, mapKey(contract, addr))

const save = (c: GuestCtx, addr: string, g: BoxGuest) => putJsonStrict(c.kv, mapKey(c.contract, addr), g)

/**
 * The payer's corner. A new one is created by the sponsor exactly like a browser guest (createGuest: re-entrant, sponsor
 * floor, one account per key), and its first deposit is this payment's toll plus the contract's storage reserve.
 */
export async function ensureGuest(c: GuestCtx, addr: string, paymentId: string): Promise<{ guest: BoxGuest; created: boolean }> {
  const known = await findGuest(c.kv, c.contract, addr)
  if (known) return { guest: known, created: false }
  const full = deriveKey(c.seed, c.contract, addr, 'full')
  const session = deriveKey(c.seed, c.contract, addr, 'session:0')
  const body = { publicKey: formatPublicKey(full.publicKey), sessionKey: formatPublicKey(session.publicKey) }
  // the same lane as POST /api/guest: one sponsored account at a time, so the floor check and the sponsor nonce hold
  const { accountId } = await serialize('sponsor-guest', () => createGuest({
    sponsor: c.sponsor, near: c.near, contract: c.contract, kv: c.kv, floorNear: c.floorNear, deposit: c.toll + ACCOUNT_STORAGE, gas: c.gas,
  }, body))
  const guest: BoxGuest = { accountId, session: 0, evmSet: false, createdBy: paymentId, at: c.now() }
  await save(c, addr, guest)
  return { guest, created: true }
}

/** Session key number `index` of a corner: it signs `challenge` (function-call only: it cannot withdraw or transfer). */
export const sessionKey = (c: GuestCtx, addr: string, index: number): KeyPair => deriveKey(c.seed, c.contract, addr, `session:${index}`)

const fullSigner = (c: GuestCtx, addr: string, g: BoxGuest): Signer => new Signer(g.accountId, deriveKey(c.seed, c.contract, addr, 'full'), c.near)

/** A session key's allowance only shrinks (NEAR never refunds gas to it): the full key adds a fresh one. */
export async function rotateSession(c: GuestCtx, addr: string, g: BoxGuest): Promise<BoxGuest> {
  const next = g.session + 1
  const key = deriveKey(c.seed, c.contract, addr, `session:${next}`)
  const full = fullSigner(c, addr, g)
  const out = await full.wait(await full.send(g.accountId, [{
    kind: 'addKeyFunctionCall', publicKey: formatPublicKey(key.publicKey), allowance: sessionAllowance(c.toll, c.gas), receiverId: c.contract, methodNames: ['challenge'],
  }]), 60_000).catch(() => null)
  if (!out || out.failure) throw new ApiError(502, 'BOOKING_FAILED', 'Could not refresh your corner\'s challenge key. Send the same request again: your payment is held.')
  const updated = { ...g, session: next }
  await save(c, addr, updated)
  return updated
}

/**
 * Register the payer's Base address on the corner (`set_evm_address`, 1 yocto, signed by the corner's full key), so a
 * purse it wins is paid to the same address that bought the shot. Best effort: false leaves `claim_payout` as the way.
 */
export async function registerPayout(c: GuestCtx, addr: string, g: BoxGuest): Promise<boolean> {
  if (g.evmSet) return true
  try {
    const out = await fullSigner(c, addr, g).call(c.contract, 'set_evm_address', { addr }, 30n * TGAS, 1n, 45_000)
    if (out.failure) return false
    await save(c, addr, { ...g, evmSet: true })
    return true
  } catch { return false }
}
