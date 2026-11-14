// The Base address that receives a player's purse payouts: read with the contract view, set with set_evm_address (1 yocto).
// Deposits need a full-access key, so these calls are always signed with the guest's FULL key, never the session key
// (which may only call `challenge` and cannot attach a deposit).
import { GameError } from '../client'
import { contractCode, type Rpc } from './rpc'
import { Signer } from './signer'
import { parseSecretKey } from './keys'
import { gameErrorFor, networkError } from './errors'

const HEX40 = /^0x[0-9a-fA-F]{40}$/

/** A 0x + 40 hex address, any letter case (an EIP-55 checksum is not required), returned lowercase. */
export function evmAddr(a: string): string {
  const t = a.trim()
  if (!HEX40.test(t)) throw new GameError('E_ADDRESS', 'Enter a Base address: 0x followed by 40 hex characters.')
  return t.toLowerCase()
}

/** Same address regardless of checksum casing. */
export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** The registered payout address of `account` (lowercase), or null when none is set or the answer is not an address. */
export async function readPayoutAddress(rpc: Rpc, contract: string, account: string): Promise<string | null> {
  const v = await rpc.view<unknown>(contract, 'get_evm_address', { account }).catch((e) => { throw networkError(e) })
  return typeof v === 'string' && HEX40.test(v.trim()) ? v.trim().toLowerCase() : null
}

/** A 1-yocto contract call signed with the account's full-access key. Returns the tx hash. */
export async function fullKeyCall(rpc: Rpc, contract: string, accountId: string, fullKey: string, method: string, args: unknown): Promise<string> {
  const out = await new Signer(accountId, parseSecretKey(fullKey), rpc).call(contract, method, args, 30_000_000_000_000n, 1n).catch((e) => { throw networkError(e) })
  if (out.failure) throw gameErrorFor(contractCode(out.failure) ?? 'E_TX_FAILED')
  return out.hash
}

/**
 * Register `addr` for future purse payouts. Validated before anything is signed; an address already registered (any casing)
 * sends nothing. Returns the tx hash, or null when nothing needed sending.
 */
export async function writePayoutAddress(rpc: Rpc, contract: string, accountId: string, fullKey: string, addr: string): Promise<string | null> {
  const a = evmAddr(addr)
  const current = await readPayoutAddress(rpc, contract, accountId).catch(() => null)
  if (sameAddress(current, a)) return null
  return fullKeyCall(rpc, contract, accountId, fullKey, 'set_evm_address', { addr: a })
}
