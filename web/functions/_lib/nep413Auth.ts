// Prove control of a NEAR testnet account: a single-use server nonce, a NEP-413 signature over it, and an on-chain check
// that the signing key is a full-access key of the account. Dependencies are injected so it runs against fakes.
import { z } from 'zod'
import { fromB64, toHex } from '../../src/game/chain/bytes'
import { RpcError, RpcUnavailable, type Rpc } from '../../src/game/chain/rpc'
import type { KVLike } from './env'
import { ApiError } from './http'
import { verifyNep413Signature } from './nep413'

export interface AuthDeps { kv: KVLike; rpc: Pick<Rpc, 'call'>; now?: () => number; random?: (n: number) => Uint8Array }

const NONCE_TTL_SEC = 300
const HOME = 'title-shot.pages.dev'
const NONCE_KEY = (hex: string) => `auth-nonce:${hex}`
interface NonceRecord { accountId: string; message: string; recipient: string; exp: number }

// nonces burned by this isolate: an immediate replay is refused even when KV still shows the record
const used = new Set<string>()
const USED_MAX = 5_000
export const resetAuthMemory = () => used.clear()

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

/** A NEAR testnet account id (named `.testnet` or a 64-hex implicit account); anything else is a 400. */
export function checkAccountId(id: string): void {
  if (id.length < 2 || id.length > 64 || !ACCOUNT.test(id)) throw new ApiError(400, 'BAD_ACCOUNT', 'That is not a NEAR account name.')
  if (id.endsWith('.near') || id === 'near') throw new ApiError(400, 'WRONG_NETWORK', 'That is a mainnet account. Title Shot runs on NEAR testnet.')
  if (!id.endsWith('.testnet') && !/^[0-9a-f]{64}$/.test(id)) throw new ApiError(400, 'BAD_ACCOUNT', 'Use a NEAR testnet account (name.testnet).')
}

const local = (h: string) => h === 'localhost' || h === '127.0.0.1'

/** Sign-in recipients we accept. localhost only when this very request came from localhost (local development). */
export function recipientAllowed(recipient: string, requestHost: string): boolean {
  if (recipient === HOME || /^[a-z0-9-]+\.title-shot\.pages\.dev$/.test(recipient)) return true
  return local(recipient) && local(requestHost)
}

export const nonceBody = z.object({ accountId: z.string().min(1).max(80), guestId: z.string().min(1).max(80).optional() })
export const verifyBody = z.object({
  accountId: z.string().min(1).max(80),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, 'expected ed25519:<base58>'),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86,88}={0,2}$/, 'expected a base64 signature'),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/, 'expected a base64 32-byte nonce'),
  recipient: z.string().min(1).max(120),
  message: z.string().min(1).max(300),
  callbackUrl: z.string().max(300).nullish(),
})

export function signInMessage(accountId: string, guestId?: string): string {
  return `Title Shot: I control ${accountId}` + (guestId ? ` and want guest corner ${guestId} moved here.` : '.')
}

export async function issueNonce(deps: AuthDeps, input: { accountId: string; guestId?: string }, recipient: string) {
  checkAccountId(input.accountId)
  const now = (deps.now ?? Date.now)()
  const bytes = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32)
  const message = signInMessage(input.accountId, input.guestId)
  const exp = now + NONCE_TTL_SEC * 1000
  const rec: NonceRecord = { accountId: input.accountId, message, recipient, exp }
  try { await deps.kv.put(NONCE_KEY(toHex(bytes)), JSON.stringify(rec), { expirationTtl: NONCE_TTL_SEC }) } catch {
    throw new ApiError(503, 'STORE_UNAVAILABLE', 'Sign-in is unavailable right now. Try again in a moment.')
  }
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return { nonce: btoa(bin), message, recipient, expiresAt: exp }
}

export async function verifyAuth(deps: AuthDeps, raw: unknown, requestHost: string): Promise<{ ok: true; accountId: string; publicKey: string }> {
  const parsed = verifyBody.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    throw new ApiError(400, 'BAD_INPUT', `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`)
  }
  const body = parsed.data
  checkAccountId(body.accountId)
  const nonceBytes = fromB64(body.nonce)
  if (nonceBytes.length !== 32) throw new ApiError(400, 'BAD_INPUT', 'nonce: expected a base64 32-byte nonce')
  const hex = toHex(nonceBytes)

  const expired = new ApiError(401, 'NONCE_UNKNOWN', 'This sign-in request expired or was already used. Try again.')
  if (used.has(hex)) throw expired
  let rec: NonceRecord | null = null
  try { const t = await deps.kv.get(NONCE_KEY(hex)); rec = t ? (JSON.parse(t) as NonceRecord) : null } catch { rec = null }
  // burn at once: from here on this nonce is spent whatever else fails
  if (used.size >= USED_MAX) used.clear()
  used.add(hex)
  try { await deps.kv.delete(NONCE_KEY(hex)) } catch { /* the in-memory set and the expiry still stop a replay */ }
  if (!rec || typeof rec.exp !== 'number' || rec.exp <= (deps.now ?? Date.now)()) throw expired

  if (rec.accountId !== body.accountId) throw new ApiError(401, 'WRONG_ACCOUNT', 'This sign-in request was made for a different account.')
  if (body.recipient !== rec.recipient || !recipientAllowed(body.recipient, requestHost)) throw new ApiError(401, 'WRONG_RECIPIENT', 'This signature was made for a different site.')
  if (body.message !== rec.message) throw new ApiError(401, 'WRONG_MESSAGE', 'The signed message does not match the sign-in request.')
  if (!verifyNep413Signature({ message: body.message, nonce: nonceBytes, recipient: body.recipient, callbackUrl: body.callbackUrl }, body.publicKey, body.signature)) {
    throw new ApiError(401, 'BAD_SIGNATURE', 'The signature does not check out.')
  }

  let key: { permission?: unknown }
  try {
    key = await deps.rpc.call('query', { request_type: 'view_access_key', finality: 'final', account_id: body.accountId, public_key: body.publicKey })
  } catch (e) {
    if (e instanceof RpcError && /^UNKNOWN_(ACCESS_KEY|ACCOUNT)$/.test(e.kind)) throw new ApiError(401, 'KEY_NOT_ON_ACCOUNT', 'That key does not belong to this account.')
    if (e instanceof RpcError || e instanceof RpcUnavailable) throw new ApiError(502, 'CHAIN_UNAVAILABLE', 'The chain is not answering. Try again in a moment.')
    throw e
  }
  // some nodes report a missing key as a result carrying an `error` string instead of an UNKNOWN_ACCESS_KEY error
  if (!key || typeof (key as { error?: unknown }).error === 'string' || key.permission === undefined) throw new ApiError(401, 'KEY_NOT_ON_ACCOUNT', 'That key does not belong to this account.')
  if (key.permission !== 'FullAccess') throw new ApiError(401, 'NOT_FULL_ACCESS', 'Sign in with a full-access key of this account.')
  return { ok: true, accountId: body.accountId, publicKey: body.publicKey }
}
