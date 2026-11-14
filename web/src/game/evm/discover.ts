// EIP-6963 multi-wallet discovery: ask every injected wallet to announce itself, keep each one's own name and icon, and fall
// back to window.ethereum (a single legacy injection) only when nothing announces.
import type { Eip1193Provider, WalletInfo, WalletOption } from './types'

export const REQUEST_EVENT = 'eip6963:requestProvider'
export const ANNOUNCE_EVENT = 'eip6963:announceProvider'
/** uuid of the window.ethereum fallback entry */
export const LEGACY_UUID = 'legacy-injected'

/** The window a wallet injects into: an event target, optionally with a legacy `ethereum`. */
export interface WalletHost {
  addEventListener(type: string, listener: (e: Event) => void): void
  removeEventListener(type: string, listener: (e: Event) => void): void
  dispatchEvent(e: Event): boolean
  ethereum?: unknown
}

const isProvider = (p: unknown): p is Eip1193Provider => !!p && typeof (p as Eip1193Provider).request === 'function'

/**
 * A safe icon for an <img>: EIP-6963 icons are data URIs (RFC 2397). Anything else (a remote URL that could track the
 * viewer, `javascript:`) is dropped and the wallet shows its initial instead.
 */
export function safeIcon(icon: unknown): string {
  if (typeof icon !== 'string' || icon.length > 200_000) return ''
  return /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/i.test(icon) ? icon : ''
}

/** Validate an announcement's detail; null when it is not a usable EIP-6963 announcement. */
export function readAnnouncement(detail: unknown): WalletOption | null {
  const d = detail as { info?: Partial<WalletInfo>; provider?: unknown } | null
  if (!d || typeof d !== 'object' || !d.info || !isProvider(d.provider)) return null
  const { uuid, name, rdns } = d.info
  if (typeof uuid !== 'string' || !uuid || typeof name !== 'string' || !name.trim()) return null
  return {
    info: { uuid, name: name.trim().slice(0, 40), icon: safeIcon(d.info.icon), rdns: typeof rdns === 'string' ? rdns.slice(0, 120) : '' },
    provider: d.provider,
  }
}

/** A readable name for a legacy injection, from the flags wallets set on it. */
export function legacyName(p: unknown): string {
  const f = p as Record<string, unknown>
  if (f.isRabby) return 'Rabby'
  if (f.isCoinbaseWallet) return 'Coinbase Wallet'
  if (f.isBraveWallet) return 'Brave Wallet'
  if (f.isMetaMask) return 'MetaMask'
  return 'Browser wallet'
}

/** The window.ethereum fallback entry, or null when there is no usable legacy provider. */
export function legacyWallet(host: Pick<WalletHost, 'ethereum'>): WalletOption | null {
  const p = host.ethereum
  return isProvider(p) ? { info: { uuid: LEGACY_UUID, name: legacyName(p), icon: '', rdns: '' }, provider: p } : null
}

/**
 * The wallets to offer: every announced wallet (first announcement per uuid wins, so a page script cannot replace a
 * wallet already listed), else the legacy injection.
 */
export function walletList(announced: WalletOption[], host: Pick<WalletHost, 'ethereum'>): WalletOption[] {
  if (announced.length) return announced
  const legacy = legacyWallet(host)
  return legacy ? [legacy] : []
}

/**
 * Listen for announcements and ask wallets to announce. `onChange` gets the full list after each new wallet. Wallets
 * that load late announce on their own when they see a later request, so the listener stays until `stop()`.
 */
export function watchWallets(host: WalletHost, onChange: (wallets: WalletOption[]) => void): { stop: () => void; refresh: () => void } {
  const announced: WalletOption[] = []
  const onAnnounce = (e: Event) => {
    const w = readAnnouncement((e as CustomEvent).detail)
    if (!w || announced.some((a) => a.info.uuid === w.info.uuid || a.provider === w.provider)) return
    announced.push(w)
    onChange(walletList(announced, host))
  }
  host.addEventListener(ANNOUNCE_EVENT, onAnnounce)
  const refresh = () => { host.dispatchEvent(new Event(REQUEST_EVENT)) }
  refresh()
  onChange(walletList(announced, host)) // the legacy fallback (or nothing) until someone announces
  return { stop: () => host.removeEventListener(ANNOUNCE_EVENT, onAnnounce), refresh }
}

/** One-shot discovery: everything that announces within `ms`. */
export function discoverWallets(host: WalletHost, ms = 400): Promise<WalletOption[]> {
  return new Promise((resolve) => {
    let latest: WalletOption[] = []
    const w = watchWallets(host, (l) => { latest = l })
    setTimeout(() => { w.stop(); resolve(latest) }, ms)
  })
}
