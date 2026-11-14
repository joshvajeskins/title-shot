// Prove a connected wallet controls its account before anything is moved to it: the server issues a single-use nonce, the
// wallet signs it with NEP-413 signMessage (off chain, no gas), and the server checks the signature and that the key is a
// FULL-ACCESS key of that account (/api/auth/nonce, /api/auth/verify).
import type { NearWalletBase } from '@hot-labs/near-connect'
import { GameError } from '../client'
import { b58decode } from '../chain/base58'
import { fromB64, toB64 } from '../chain/bytes'
import { isRejection, messageOf } from './connector'

interface NonceRes { nonce: string; message: string; recipient: string; expiresAt: number }

async function post<T>(path: string, body: unknown, fetchFn: typeof fetch): Promise<T> {
  let r: Response
  try {
    r = await fetchFn(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new GameError('E_NETWORK', 'Could not reach Title Shot. Check your connection and try again.')
  }
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; code?: string }
  if (!r.ok) throw new GameError(j.code ?? 'E_AUTH', j.error ?? 'The wallet check failed. Try again.')
  return j
}

/** Wallets should return base64 (NEP-413); a few return base58 or "ed25519:<base58>". Normalise to base64 of 64 bytes. */
export function signatureB64(sig: string): string {
  const s = sig.startsWith('ed25519:') ? sig.slice(8) : sig
  try { if (fromB64(s).length === 64) return toB64(fromB64(s)) } catch { /* not base64 */ }
  try { const b = b58decode(s); if (b.length === 64) return toB64(b) } catch { /* not base58 */ }
  return s
}

/** Ask the wallet to sign the server's nonce and have the server verify it. Resolves with the verified account. */
export async function proveControl(wallet: NearWalletBase, accountId: string, guestId: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<{ accountId: string; publicKey: string }> {
  const n = await post<NonceRes>('/api/auth/nonce', { accountId, guestId }, fetchFn)
  let signed: { accountId?: string; publicKey: string; signature: string }
  try {
    signed = await wallet.signMessage({ message: n.message, recipient: n.recipient, nonce: fromB64(n.nonce), signerId: accountId, network: 'testnet' })
  } catch (e) {
    throw new GameError('E_WALLET_REJECTED', isRejection(e) ? 'You declined the message in your wallet. Nothing was moved.' : `Your wallet could not sign the message: ${messageOf(e)}`)
  }
  if (!signed?.signature || !signed.publicKey) throw new GameError('E_WALLET', 'Your wallet did not return a signature. Try another wallet.')
  if (signed.accountId && signed.accountId !== accountId) throw new GameError('E_WALLET_SWITCHED', `Your wallet signed as ${signed.accountId}, not ${accountId}.`)
  return post<{ ok: true; accountId: string; publicKey: string }>('/api/auth/verify', {
    accountId, publicKey: signed.publicKey, signature: signatureB64(signed.signature), nonce: n.nonce, recipient: n.recipient, message: n.message,
  }, fetchFn)
}
