// Contract calls a wallet account makes through its own wallet (NEAR Connect): the ones that need 1 yocto or move money,
// which the browser's session key can never sign (withdraw, set_evm_address, claim_payout).
import type { NearWalletBase } from '@hot-labs/near-connect'
import { GameError } from '../client'
import { contractCode, parseOutcome } from '../chain/rpc'
import { gameErrorFor } from '../chain/errors'
import { isRejection, messageOf, walletFor } from './connector'

export const OWNER_GAS = 30_000_000_000_000n // 30 Tgas

export type WalletTx = { receiverId: string; actions: WalletAction[] }
export type WalletAction =
  | { type: 'FunctionCall'; params: { methodName: string; args: object; gas: string; deposit: string } }
  | { type: 'AddKey'; params: { publicKey: string; accessKey: { permission: { receiverId: string; allowance?: string; methodNames?: string[] } } } }

export const functionCall = (methodName: string, args: object, gas: bigint, deposit: bigint): WalletAction =>
  ({ type: 'FunctionCall', params: { methodName, args, gas: gas.toString(), deposit: deposit.toString() } })

/** The tx hash of a FinalExecutionOutcome (shapes differ slightly between wallets). */
export function hashOf(o: unknown): string {
  const r = o as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | null
  return r?.transaction?.hash ?? r?.transaction_outcome?.id ?? ''
}

/** A failed receipt inside a wallet's outcome becomes the contract's readable error. */
export function checkOutcome(o: unknown): string {
  const out = parseOutcome(o)
  if (out.failure) throw gameErrorFor(contractCode(out.failure) ?? 'E_TX_FAILED')
  return hashOf(o)
}

export function walletError(e: unknown, what: string): GameError {
  if (e instanceof GameError) return e
  if (isRejection(e)) return new GameError('E_WALLET_REJECTED', `You declined ${what} in your wallet. Nothing was sent.`)
  return new GameError('E_WALLET', `Your wallet could not send ${what}: ${messageOf(e)}`)
}

/**
 * Send several transactions with one approval when the wallet supports batches (signAndSendTransactions), else one by one.
 * Returns the raw outcomes in order.
 */
export async function sendAll(wallet: NearWalletBase, signerId: string, txs: WalletTx[]): Promise<unknown[]> {
  if (txs.length === 1) return [await wallet.signAndSendTransaction({ signerId, network: 'testnet', ...txs[0]! })]
  if (wallet.manifest?.features?.signAndSendTransactions !== false) {
    return wallet.signAndSendTransactions({ signerId, network: 'testnet', transactions: txs })
  }
  const out: unknown[] = []
  for (const tx of txs) out.push(await wallet.signAndSendTransaction({ signerId, network: 'testnet', ...tx }))
  return out
}

/** One owner-only contract call (1 yocto by default) through the account's wallet. Returns the tx hash. */
export async function walletContractCall(contract: string, accountId: string, method: string, args: object, deposit = 1n): Promise<string> {
  const wallet = await walletFor(accountId)
  let outcome: unknown
  try {
    outcome = await wallet.signAndSendTransaction({ signerId: accountId, network: 'testnet', receiverId: contract, actions: [functionCall(method, args, OWNER_GAS, deposit)] })
  } catch (e) {
    throw walletError(e, describe(method))
  }
  return checkOutcome(outcome)
}

const describe = (method: string): string =>
  method === 'withdraw' ? 'the withdrawal' : method === 'set_evm_address' ? 'the payout address' : method === 'claim_payout' ? 'the payout claim' : 'the call'
