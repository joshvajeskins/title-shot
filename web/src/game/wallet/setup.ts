// Turn a connected NEAR wallet into a fighter corner with ONE approval: the wallet adds a session key the browser generated
// (function-call only: receiver = the game contract, method `challenge`) and deposits the fight money. From then on the
// session key signs every challenge, exactly like a guest's, and the wallet is asked again only to move money out.
import type { NearWalletBase } from '@hot-labs/near-connect'
import { GameError } from '../client'
import { formatPublicKey, formatSecretKey, generateKeyPair, parseSecretKey } from '../chain/keys'
import { Rpc, RpcError } from '../chain/rpc'
import { txUrl } from '../chain/config'
import { activateWallet, browserStore, type KeyStore } from '../nearKeys'
import { checkOutcome, functionCall, sendAll, walletError, OWNER_GAS, type WalletTx } from './calls'
import { rpcUrls } from './connector'

const NEAR = 10n ** 24n
export const DEFAULT_FIGHT_MONEY = NEAR / 5n // 0.2 NEAR
export const FIGHT_MONEY_CHOICES = [NEAR / 10n, NEAR / 5n, NEAR / 2n, NEAR] as const
/** The contract keeps 0.005 NEAR of an account's first deposit for its storage. */
export const FIRST_DEPOSIT_MIN = 5n * NEAR / 1000n
/** Gas the session key may spend over its life (NEAR Connect's default): about 50 relayer-mode challenges. */
export const SESSION_ALLOWANCE = NEAR / 4n
/** Kept back in the wallet when checking what it can deposit: the two transactions' gas and its own storage. */
export const WALLET_HEADROOM = NEAR / 20n
const PENDING_KEY = 'ts-wallet-pending'

export interface Receipt { label: string; tx: string; url: string }
export type SetupStage = 'approve' | 'confirm'

/** The session key for `accountId`: the one an interrupted setup already generated (it may be on chain), or a new one. */
function sessionKeyFor(store: KeyStore, accountId: string): string {
  try {
    const p = JSON.parse(store.get(PENDING_KEY) ?? 'null') as { accountId?: string; sessionKey?: string } | null
    if (p?.accountId === accountId && p.sessionKey?.startsWith('ed25519:')) return p.sessionKey
  } catch { /* unreadable: start over */ }
  const sessionKey = formatSecretKey(generateKeyPair())
  store.set(PENDING_KEY, JSON.stringify({ accountId, sessionKey, createdAt: Date.now() }))
  return sessionKey
}

/** Is `publicKey` on `accountId` as a function-call key for `contract` with `challenge`? null when the chain cannot be read. */
export async function hasSessionKey(rpc: Rpc, accountId: string, publicKey: string, contract: string): Promise<boolean | null> {
  try {
    const r = await rpc.call<{ permission?: unknown }>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey })
    const fc = (r?.permission as { FunctionCall?: { receiver_id?: string; method_names?: string[] } } | undefined)?.FunctionCall
    return !!fc && fc.receiver_id === contract && (fc.method_names ?? []).includes('challenge')
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(e.kind + e.message)) return false
    return null
  }
}

/** The account's spendable NEAR (amount minus what its storage locks), for the fight-money picker. */
export async function walletBalance(accountId: string, rpc = new Rpc({ urls: rpcUrls() })): Promise<bigint> {
  const r = await rpc.call<{ amount: string; locked?: string; storage_usage?: number }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId })
  const storage = BigInt(r.storage_usage ?? 0) * 10n ** 19n
  const free = BigInt(r.amount) - storage
  return free > 0n ? free : 0n
}

export interface SetupInput {
  wallet: NearWalletBase
  accountId: string
  walletId: string
  contract: string
  /** yocto credited to the account's game balance; 0 skips the deposit (a returning account with money already in) */
  deposit: bigint
  store?: KeyStore
  rpc?: Rpc
  onStage?: (s: SetupStage) => void
  sleep?: (ms: number) => Promise<void>
}

/** The batch the wallet is asked to approve: AddKey on the account itself, then `deposit` on the contract. */
export function setupTransactions(accountId: string, sessionPublic: string, contract: string, deposit: bigint, keyOnChain: boolean): WalletTx[] {
  const txs: WalletTx[] = []
  if (!keyOnChain) {
    txs.push({ receiverId: accountId, actions: [{ type: 'AddKey', params: { publicKey: sessionPublic, accessKey: { permission: { receiverId: contract, allowance: SESSION_ALLOWANCE.toString(), methodNames: ['challenge'] } } } }] })
  }
  if (deposit > 0n) txs.push({ receiverId: contract, actions: [functionCall('deposit', {}, OWNER_GAS, deposit)] })
  return txs
}

/**
 * Ask the wallet for the one approval, confirm the key landed, then make this wallet account the active one.
 * Nothing is stored as active until the key is on chain, so a declined or failed approval leaves the page as it was.
 */
export async function setupWallet(i: SetupInput): Promise<{ accountId: string; receipts: Receipt[] }> {
  const store = i.store ?? browserStore()
  const rpc = i.rpc ?? new Rpc({ urls: rpcUrls() })
  const sleep = i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if (i.deposit > 0n && i.deposit < FIRST_DEPOSIT_MIN) throw new GameError('E_AMOUNT', 'Deposit at least 0.005 NEAR (the contract keeps that much for your storage).')
  const sessionKey = sessionKeyFor(store, i.accountId)
  const sessionPublic = formatPublicKey(parseSecretKey(sessionKey).publicKey)
  const keyOnChain = (await hasSessionKey(rpc, i.accountId, sessionPublic, i.contract)) === true
  const txs = setupTransactions(i.accountId, sessionPublic, i.contract, i.deposit, keyOnChain)
  const receipts: Receipt[] = []
  if (txs.length) {
    i.onStage?.('approve')
    let outcomes: unknown[]
    try {
      outcomes = await sendAll(i.wallet, i.accountId, txs)
    } catch (e) {
      throw walletError(e, 'the setup')
    }
    outcomes.forEach((o, n) => {
      const hash = checkOutcome(o)
      const label = txs[n]!.actions[0]!.type === 'AddKey' ? 'session key added' : 'fight money deposited'
      if (hash) receipts.push({ label, tx: hash, url: txUrl(hash) })
    })
  }
  i.onStage?.('confirm')
  // the wallet answered; wait until an RPC node sees the key before the first challenge relies on it
  let seen = keyOnChain
  for (let n = 0; n < 12 && !seen; n++) {
    seen = (await hasSessionKey(rpc, i.accountId, sessionPublic, i.contract)) === true
    if (!seen) await sleep(1200)
  }
  if (!seen) throw new GameError('E_SLOW', 'The wallet approved, but the network has not shown the session key yet. Try again in a minute: the same key is reused.')
  activateWallet(store, { accountId: i.accountId, sessionKey, walletId: i.walletId })
  store.remove(PENDING_KEY)
  return { accountId: i.accountId, receipts }
}
