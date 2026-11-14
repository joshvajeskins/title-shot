// Owner-only contract calls (1 yocto: set_evm_address, claim_payout, withdraw). A guest signs them with its full-access key in
// this browser; a wallet account asks its own wallet through NEAR Connect (loaded on demand, so guests never download it).
import { GameError } from './client'
import type { Rpc } from './chain/rpc'
import { fullKeyCall, writePayoutAddress } from './chain/payout'
import { archiveStored, loadStored, type KeyStore, type StoredAccount } from './nearKeys'
import { networkError } from './chain/errors'

const need = (st: StoredAccount | null): StoredAccount => {
  if (!st) throw new GameError('E_NO_ACCOUNT', 'Connect your wallet first, or open the judge demo.')
  return st
}

/** One owner-only call for the active account. Returns the tx hash. */
export async function ownerCall(rpc: Rpc, contract: string, stored: StoredAccount | null, method: string, args: Record<string, unknown>): Promise<string> {
  const st = need(stored)
  if (st.kind === 'wallet') {
    const { walletContractCall } = await import('./wallet/calls')
    return walletContractCall(contract, st.accountId, method, args)
  }
  return fullKeyCall(rpc, contract, st.accountId, st.fullKey, method, args)
}

/** Register `addr` (already validated) for purse payouts; an address already registered sends nothing. */
export async function ownerSetPayout(rpc: Rpc, contract: string, stored: StoredAccount | null, addr: string): Promise<string | null> {
  const st = need(stored)
  if (st.kind !== 'wallet') return writePayoutAddress(rpc, contract, st.accountId, st.fullKey, addr)
  // No read before the wallet call: the payout dialog only offers Save for a changed address, and a web wallet's sign tab is
  // blocked by the browser if a network round trip sits between the tap and the wallet.
  return ownerCall(rpc, contract, st, 'set_evm_address', { addr })
}

/** Sign out: a guest's keys go to the archive (still exportable); a wallet account also signs out of NEAR Connect. */
export async function signOutStored(store: KeyStore): Promise<void> {
  const wallet = loadStored(store)?.kind === 'wallet'
  archiveStored(store)
  if (wallet) await import('./wallet/connector').then((m) => m.disconnectWallet()).catch(() => undefined)
}

/** A failed `challenge` send (signed by the session key) as a sentence the player can act on. */
export function sessionSendError(e: unknown, wallet: boolean): GameError {
  const m = e instanceof Error ? e.message : String(e)
  if (/NotEnoughAllowance|allowance/i.test(m)) {
    return new GameError('E_ALLOWANCE', wallet
      ? 'This browser\'s session key has used up its gas allowance. Disconnect and connect your wallet again to get a fresh one.'
      : 'This demo account has used up its gas allowance. Connect your wallet to keep fighting.')
  }
  if (/NotEnoughBalance|LackBalanceForState/i.test(m)) {
    return new GameError('E_GAS_BALANCE', wallet ? 'Your wallet account is out of NEAR for gas. Top it up from a testnet faucet.' : 'This demo account is out of gas money. Connect your wallet to keep fighting.')
  }
  if (/MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall/i.test(m)) return new GameError('E_KEY', 'This corner\'s key cannot sign that action.')
  return networkError(e)
}
