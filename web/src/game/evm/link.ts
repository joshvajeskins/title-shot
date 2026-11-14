// The whole "connect a wallet" flow for a purse payout address: connect, put the wallet on Base Sepolia, sign the binding
// message, verify it. Pure over an EIP-1193 provider, so every branch is tested with a scripted provider.
import { isAddress } from 'viem'
import { ensureBaseSepolia, BASE_SEPOLIA_ID } from './chain'
import { bindingMessage, newNonce, personalSignParams, verifyBinding } from './proof'
import { errorCode, REQUEST_PENDING, USER_REJECTED, WalletError, type Eip1193Provider, type WalletErrorKind } from './types'

export type LinkStep = 'connecting' | 'switching' | 'signing' | 'verifying'

export interface Linked {
  /** lowercase, as the contract stores it */
  address: string
  message: string
  signature: string
  /** the wallet had to change network */
  switched: boolean
}

export interface LinkOptions {
  provider: Eip1193Provider
  nearAccount: string
  domain: string
  nonce?: string
  now?: () => Date
  onStep?: (s: LinkStep) => void
  signal?: AbortSignal
  verify?: typeof verifyBinding
}

const firstAddress = (v: unknown): string | null => {
  const a = Array.isArray(v) ? v[0] : null
  return typeof a === 'string' && isAddress(a, { strict: false }) ? a.toLowerCase() : null
}

/** A wallet's failure as a WalletError: 4001 is the user saying no to this step, -32002 a request already open. */
export function asWalletError(e: unknown, onReject: WalletErrorKind): WalletError {
  if (e instanceof WalletError) return e
  const code = errorCode(e)
  if (code === USER_REJECTED) return new WalletError(onReject, 'Declined in the wallet.')
  if (code === REQUEST_PENDING) return new WalletError('pending', 'The wallet already has a request open.')
  const msg = (e as { shortMessage?: string; message?: string } | null)?.shortMessage ?? (e as Error | null)?.message
  return new WalletError('failed', typeof msg === 'string' && msg ? msg.slice(0, 200) : 'The wallet returned an error.')
}

/** Settle with `p`, or reject as soon as `signal` aborts (a wallet prompt may never answer once the user moved on). */
function race<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason instanceof WalletError ? signal.reason : new WalletError('cancelled', 'Cancelled.'))
    if (signal.aborted) return stop()
    signal.addEventListener('abort', stop, { once: true })
    p.then((v) => { signal.removeEventListener('abort', stop); resolve(v) }, (e) => { signal.removeEventListener('abort', stop); reject(e) })
  })
}

/**
 * Connect `provider`, switch it to Base Sepolia, have it sign the binding message and verify the signature. Throws
 * WalletError. An account change after connecting (event, or a different account once the signature is back) fails the
 * flow as `account-changed`, so a signature is only ever accepted for the account that made it.
 */
export async function linkWallet(o: LinkOptions): Promise<Linked> {
  const { provider: p } = o
  const ctl = new AbortController()
  const outer = () => ctl.abort(o.signal?.reason)
  o.signal?.addEventListener('abort', outer, { once: true })
  if (o.signal?.aborted) outer()
  let address: string | null = null
  const onAccounts = (accounts: unknown) => {
    const next = firstAddress(accounts)
    if (address && next !== address) ctl.abort(new WalletError('account-changed', 'The wallet changed accounts.', { from: address, to: next ?? undefined }))
  }
  p.on?.('accountsChanged', onAccounts)
  const ask = <T = unknown>(method: string, params: readonly unknown[] | undefined, onReject: WalletErrorKind) =>
    race(p.request({ method, params }) as Promise<T>, ctl.signal).catch((e) => { throw asWalletError(e, onReject) })
  try {
    o.onStep?.('connecting')
    address = firstAddress(await ask('eth_requestAccounts', undefined, 'rejected'))
    if (!address) throw new WalletError('no-account', 'The wallet shared no account.')

    o.onStep?.('switching')
    const switched = await race(ensureBaseSepolia(p), ctl.signal).catch((e) => { throw asWalletError(e, 'chain-refused') })

    o.onStep?.('signing')
    const message = bindingMessage({ nearAccount: o.nearAccount, address, domain: o.domain, nonce: o.nonce ?? newNonce(), issuedAt: (o.now?.() ?? new Date()).toISOString(), chainId: BASE_SEPOLIA_ID })
    const signature = await ask<unknown>('personal_sign', personalSignParams(message, address), 'sign-rejected')
    if (typeof signature !== 'string') throw new WalletError('bad-signature', 'The wallet returned no signature.')

    o.onStep?.('verifying')
    // the wallet may have moved to another account while its prompt was open
    const still = firstAddress(await ask('eth_accounts', undefined, 'failed').catch(() => [address]))
    if (still && still !== address) throw new WalletError('account-changed', 'The wallet changed accounts.', { from: address, to: still })
    if (!(await (o.verify ?? verifyBinding)(message, signature, address))) throw new WalletError('bad-signature', 'The signature does not match this address.')
    if (ctl.signal.aborted) throw ctl.signal.reason instanceof WalletError ? ctl.signal.reason : new WalletError('cancelled', 'Cancelled.')
    return { address, message, signature, switched }
  } finally {
    p.removeListener?.('accountsChanged', onAccounts)
    o.signal?.removeEventListener('abort', outer)
  }
}

/** Best effort "disconnect": wallets that support EIP-2255 drop this site's account permission; the rest just forget. */
export async function revoke(p: Eip1193Provider): Promise<void> {
  await p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => undefined)
}
