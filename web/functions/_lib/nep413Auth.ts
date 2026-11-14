// Prove control of a NEAR testnet account: a single-use server nonce, a NEP-413 signature over it, and an on-chain check
// that the signing key is a full-access key of the account. Dependencies are injected so it runs against fakes.
import { z } from 'zod'
import { fromB64, toHex } from '../../src/game/chain/bytes'
import { RpcError, RpcUnavailable, type Rpc } from '../../src/game/chain/rpc'
import type { KVLike } from './env'
import { ApiError } from './http'
import { recoverMessageAddress } from 'viem'
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

const EVM_ACCOUNT = /^0x[0-9a-f]{40}$/
export const isEvmAccount = (id: string) => EVM_ACCOUNT.test(id)

/** A NEAR testnet account id (named `.testnet`, a 64-hex implicit account or a lowercase 0x Ethereum-implicit one); anything else is a 400. */
export function checkAccountId(id: string): void {
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) {
    if (!EVM_ACCOUNT.test(id)) throw new ApiError(400, 'BAD_ACCOUNT', 'Use the lowercase form of your 0x account (no capital letters).')
    return
  }
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

export const eip191Body = z.object({
  scheme: z.literal('eip191'),
  accountId: z.string().min(1).max(80),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'expected a 0x signature of 65 bytes'),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/, 'expected a base64 32-byte nonce'),
  recipient: z.string().min(1).max(120),
  message: z.string().min(1).max(400),
})

export function signInMessage(accountId: string, guestId?: string): string {
  return `Title Shot: I control ${accountId}` + (guestId ? ` and want demo account ${guestId} moved here.` : '.')
}

export async function issueNonce(deps: AuthDeps, input: { accountId: string; guestId?: string }, recipient: string) {
  checkAccountId(input.accountId)
  const now = (deps.now ?? Date.now)()
  const bytes = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const nonce = btoa(bin)
  const evm = isEvmAccount(input.accountId)
  // personal_sign carries no structured recipient or nonce, so the text itself binds them
  const message = signInMessage(input.accountId, input.guestId) + (evm ? `\nDomain: ${recipient}\nNonce: ${nonce}` : '')
  const exp = now + NONCE_TTL_SEC * 1000
  const rec: NonceRecord = { accountId: input.accountId, message, recipient, exp }
  try { await deps.kv.put(NONCE_KEY(toHex(bytes)), JSON.stringify(rec), { expirationTtl: NONCE_TTL_SEC }) } catch {
    throw new ApiError(503, 'STORE_UNAVAILABLE', 'Sign-in is unavailable right now. Try again in a moment.')
  }
  return { nonce, message, recipient, expiresAt: exp, scheme: evm ? ('eip191' as const) : ('nep413' as const) }
}

const badInput = (parsed: { error: z.ZodError }) => {
  const i = parsed.error.issues[0]
  return new ApiError(400, 'BAD_INPUT', `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`)
}

/** Load and burn a nonce (single use, whatever happens next); returns its record or throws NONCE_UNKNOWN. */
async function burnNonce(deps: AuthDeps, nonceB64: string): Promise<{ rec: NonceRecord; nonceBytes: Uint8Array }> {
  const nonceBytes = fromB64(nonceB64)
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
  return { rec, nonceBytes }
}

async function verifyEip191(deps: AuthDeps, raw: unknown, requestHost: string): Promise<{ ok: true; accountId: string; scheme: 'eip191' }> {
  const parsed = eip191Body.safeParse(raw)
  if (!parsed.success) throw badInput(parsed)
  const body = parsed.data
  checkAccountId(body.accountId)
  if (!isEvmAccount(body.accountId)) throw new ApiError(400, 'BAD_INPUT', 'personal_sign sign-in is only for 0x accounts.')
  const { rec } = await burnNonce(deps, body.nonce)
  if (rec.accountId !== body.accountId) throw new ApiError(401, 'WRONG_ACCOUNT', 'This sign-in request was made for a different account.')
  if (body.recipient !== rec.recipient || !recipientAllowed(body.recipient, requestHost)) throw new ApiError(401, 'WRONG_RECIPIENT', 'This signature was made for a different site.')
  if (body.message !== rec.message) throw new ApiError(401, 'WRONG_MESSAGE', 'The signed message does not match the sign-in request.')
  let ok = false
  try { ok = (await recoverMessageAddress({ message: body.message, signature: body.signature as `0x${string}` })).toLowerCase() === body.accountId } catch { ok = false }
  if (!ok) throw new ApiError(401, 'BAD_SIGNATURE', 'The signature does not check out.')
  return { ok: true, accountId: body.accountId, scheme: 'eip191' }
}

export async function verifyAuth(deps: AuthDeps, raw: unknown, requestHost: string): Promise<{ ok: true; accountId: string; publicKey: string } | { ok: true; accountId: string; scheme: 'eip191' }> {
  const scheme = raw && typeof raw === 'object' ? (raw as { scheme?: unknown }).scheme : undefined
  if (scheme === 'eip191') return verifyEip191(deps, raw, requestHost)
  if (scheme !== undefined && scheme !== 'nep413') throw new ApiError(400, 'BAD_INPUT', 'scheme: expected nep413 or eip191')
  if (raw && typeof raw === 'object') { const { scheme: _s, ...rest } = raw as Record<string, unknown>; raw = rest }
  const parsed = verifyBody.safeParse(raw)
  if (!parsed.success) throw badInput(parsed)
  const body = parsed.data
  checkAccountId(body.accountId)
  if (isEvmAccount(body.accountId)) throw new ApiError(400, 'BAD_INPUT', 'This account signs with personal_sign (scheme eip191), not NEP-413.')
  const { rec, nonceBytes } = await burnNonce(deps, body.nonce)

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
