// EIP-1193 providers and the errors the payout wallet flow can end in. No SDK: the dialog talks to injected wallets directly.

export interface Eip1193Request { method: string; params?: readonly unknown[] | Record<string, unknown> }
export interface Eip1193Provider {
  request(args: Eip1193Request): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

/** EIP-6963 announcement: the wallet's own name and icon, and its provider. */
export interface WalletInfo { uuid: string; name: string; icon: string; rdns: string }
export interface WalletOption { info: WalletInfo; provider: Eip1193Provider }

export type WalletErrorKind =
  | 'rejected' // the user declined the connection
  | 'sign-rejected' // the user declined to sign
  | 'chain-refused' // the user declined to switch to (or add) Base Sepolia
  | 'wrong-chain' // the wallet is still on another chain (switch unsupported or did not take)
  | 'account-changed' // the wallet changed accounts mid-flow
  | 'no-account' // the wallet returned no account
  | 'pending' // the wallet already has a request open
  | 'bad-signature' // the signature does not recover to the connected address
  | 'cancelled' // the user cancelled in the dialog
  | 'failed'

export class WalletError extends Error {
  readonly kind: WalletErrorKind
  readonly detail: { chainId?: number; from?: string; to?: string }
  constructor(kind: WalletErrorKind, message: string, detail: WalletError['detail'] = {}) {
    super(message)
    this.kind = kind
    this.detail = detail
  }
}

/** The EIP-1193 / JSON-RPC error code, looking inside the wrappers some wallets add (MetaMask mobile: data.originalError). */
export function errorCode(e: unknown): number | undefined {
  const o = e as { code?: unknown; data?: { originalError?: { code?: unknown } }; cause?: unknown } | null
  if (!o || typeof o !== 'object') return undefined
  const inner = o.data?.originalError?.code
  if (typeof inner === 'number') return inner
  if (typeof o.code === 'number') return o.code
  return o.cause ? errorCode(o.cause) : undefined
}

export const USER_REJECTED = 4001
export const UNRECOGNIZED_CHAIN = 4902
export const UNSUPPORTED_METHOD = 4200
export const REQUEST_PENDING = -32002

/** Parse an eth_chainId answer ("0x14a34", or a number from older wallets). */
export function chainIdOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v
  if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) return Number.parseInt(v, 16)
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}
