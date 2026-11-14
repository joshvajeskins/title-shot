// Owner-only contract calls (1 yocto: set_evm_address, claim_payout, withdraw). A guest signs them with its full-access key in
// this browser; a wallet account asks its own wallet through NEAR Connect (loaded on demand, so guests never download it).
import { GameError } from './client'
import type { Rpc } from './chain/rpc'
import { fullKeyCall, readPayoutAddress, sameAddress, writePayoutAddress } from './chain/payout'
import { archiveStored, loadStored, type KeyStore, type StoredAccount } from './nearKeys'
import { networkError } from './chain/errors'

const need = (st: StoredAccount | null): StoredAccount => {
  if (!st) throw new GameError('E_NO_ACCOUNT', 'Create your guest corner first.')
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
  const current = await readPayoutAddress(rpc, contract, st.accountId).catch(() => null)
  if (sameAddress(current, addr)) return null
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
      : 'This guest corner has used up its gas allowance. Create a new guest corner to keep fighting.')
  }
  if (/NotEnoughBalance|LackBalanceForState/i.test(m)) {
    return new GameError('E_GAS_BALANCE', wallet ? 'Your wallet account is out of NEAR for gas. Top it up from a testnet faucet.' : 'This guest corner is out of gas money. Create a new guest corner.')
  }
  if (/MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall/i.test(m)) return new GameError('E_KEY', 'This corner\'s key cannot sign that action.')
  return networkError(e)
}
