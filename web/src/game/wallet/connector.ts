// NEAR Connect (@hot-labs/near-connect), the official NEAR wallet connector. Loaded on demand, so guests who never touch a
// wallet never download it. One connector per page, pinned to testnet.
import type { NearConnector, NearWalletBase } from '@hot-labs/near-connect'
import { GameError } from '../client'
import { DEFAULT_RPC_URLS, Rpc, RpcError } from '../chain/rpc'

let connectorP: Promise<NearConnector> | null = null

export function rpcUrls(): string[] {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
  const list = (env.VITE_NEAR_RPC ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : DEFAULT_RPC_URLS
}

/** The page's NearConnector (testnet only), created on first use. */
export function connector(): Promise<NearConnector> {
  connectorP ??= import('@hot-labs/near-connect').then(async ({ NearConnector }) => {
    const c = new NearConnector({ network: 'testnet', providers: { testnet: rpcUrls() } })
    await c.whenManifestLoaded
    return c
  }).catch((e: unknown) => { connectorP = null; throw e })
  return connectorP
}

/** The words wallets use when the person closes or declines a request. */
export function isRejection(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e ?? '')
  return /reject|denied|cancel|closed|declin|abort|user.*(close|refus)/i.test(m)
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return 'The wallet returned an error.'
}

/** A NEAR account this testnet game can use: a `.testnet` name, or an implicit account that exists on testnet. */
export async function assertTestnetAccount(accountId: string, rpc = new Rpc({ urls: rpcUrls() })): Promise<void> {
  const id = accountId.trim().toLowerCase()
  if (id.endsWith('.near') || (!id.endsWith('.testnet') && !/^[0-9a-f]{64}$/.test(id) && !/^0x[0-9a-f]{40}$/.test(id))) {
    throw new GameError('E_WRONG_NETWORK', `${accountId} is a mainnet account. Title Shot runs on NEAR testnet: switch your wallet to testnet and connect again.`)
  }
  try {
    await rpc.balance(id)
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_ACCOUNT/.test(e.kind + e.message)) {
      throw new GameError('E_WRONG_NETWORK', `${accountId} does not exist on NEAR testnet. Switch your wallet to testnet and connect again.`)
    }
    throw new GameError('E_NETWORK', 'Could not reach NEAR testnet to check your account. Try again.')
  }
}

export interface Connected { wallet: NearWalletBase; accountId: string; walletId: string; walletName: string }

/**
 * Open the NEAR Connect wallet picker and sign in. `needs` limits the list to wallets with those features (message signing
 * for the move). A mainnet account is signed out again and refused.
 */
export async function connectWallet(needs: { signMessage?: boolean } = {}): Promise<Connected> {
  const c = await connector()
  let walletId: string
  try {
    walletId = await c.selectWallet({ features: needs.signMessage ? { signMessage: true } : {} })
  } catch (e) {
    throw new GameError('E_WALLET_CLOSED', isRejection(e) ? 'No wallet picked. Your account is untouched.' : messageOf(e))
  }
  let wallet: NearWalletBase
  try {
    wallet = await c.connect({ walletId })
  } catch (e) {
    throw new GameError('E_WALLET_REJECTED', isRejection(e) ? 'The wallet sign-in was cancelled. Nothing was changed.' : `The wallet could not sign in: ${messageOf(e)}`)
  }
  const accountId = (await wallet.getAccounts().catch(() => []))[0]?.accountId ?? ''
  if (!accountId) {
    await c.disconnect(wallet).catch(() => undefined)
    throw new GameError('E_WALLET_REJECTED', 'The wallet did not share an account. Try again.')
  }
  try {
    await assertTestnetAccount(accountId)
  } catch (e) {
    await c.disconnect(wallet).catch(() => undefined)
    throw e
  }
  return { wallet, accountId, walletId, walletName: wallet.manifest?.name ?? walletId }
}

/** The wallet this page is signed in to, checked against the account the game expects. */
export async function walletFor(accountId: string): Promise<NearWalletBase> {
  const c = await connector()
  let wallet: NearWalletBase
  try {
    wallet = await c.wallet()
  } catch {
    throw new GameError('E_WALLET_GONE', `Your wallet is signed out. Reconnect ${accountId} from the account menu.`)
  }
  const now = (await wallet.getAccounts().catch(() => []))[0]?.accountId
  if (now && now !== accountId) throw new GameError('E_WALLET_SWITCHED', `Your wallet is signed in as ${now}, not ${accountId}. Switch back in the wallet, or disconnect and reconnect.`)
  return wallet
}

/** Sign out of the wallet (best effort: the game's own session is cleared by the caller either way). */
export async function disconnectWallet(): Promise<void> {
  if (!connectorP) {
    // nothing loaded on this page: only touch NEAR Connect when it remembers a wallet
    let remembered: string | null = null
    try { remembered = localStorage.getItem('selected-wallet') } catch { /* blocked storage */ }
    if (!remembered) return
  }
  const c = await connector().catch(() => null)
  if (!c) return
  await c.disconnect().catch(() => undefined)
}

/** The game contract this build talks to (empty in the offline demo). */
export function contractId(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
  return (env.VITE_CONTRACT_ID ?? '').trim()
}

/** A wallet NEAR Connect still remembers from before a reload (only loads NEAR Connect when one is remembered). */
export async function rememberedWallet(): Promise<Connected | null> {
  let id: string | null = null
  try { id = localStorage.getItem('selected-wallet') } catch { /* blocked storage */ }
  if (!id) return null
  const c = await connector()
  const got = await c.getConnectedWallet().catch(() => null)
  const accountId = got?.accounts[0]?.accountId
  if (!got || !accountId) return null
  return { wallet: got.wallet, accountId, walletId: got.wallet.manifest.id, walletName: got.wallet.manifest.name }
}
