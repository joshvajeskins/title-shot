// Base Sepolia JSON-RPC helpers (plain fetch via the shared Rpc client) and Chain Signatures address derivation.
import { keccak_256 } from '@noble/hashes/sha3.js'
import { b58decode } from '../../src/game/chain/base58'
import { fromHex, toHex } from '../../src/game/chain/bytes'
import type { Rpc } from '../../src/game/chain/rpc'
import type { FeeHistory } from './fees'

export const BASE_CHAIN_ID = 84532

/** "secp256k1:<base58(X||Y)>" from the MPC signer's `derived_public_key` -> 0x address. */
export function addressFromDerivedKey(key: string): string {
  if (!key.startsWith('secp256k1:')) throw new Error('not a secp256k1 key')
  const xy = b58decode(key.slice('secp256k1:'.length))
  if (xy.length !== 64) throw new Error('derived key must be 64 bytes')
  return '0x' + toHex(keccak_256(xy).slice(12))
}

export async function deriveEvmAddress(near: Rpc, mpcSigner: string, path: string, predecessor: string): Promise<string> {
  const key = await near.view<string>(mpcSigner, 'derived_public_key', { path, predecessor, domain_id: 0 })
  return addressFromDerivedKey(key)
}

const q = (n: bigint) => '0x' + n.toString(16)

export const getBalance = async (base: Rpc, addr: string): Promise<bigint> => BigInt(await base.call<string>('eth_getBalance', [addr, 'latest']))
export const getNonce = async (base: Rpc, addr: string): Promise<bigint> => BigInt(await base.call<string>('eth_getTransactionCount', [addr, 'pending']))
export const getFeeHistory = (base: Rpc): Promise<FeeHistory> => base.call<FeeHistory>('eth_feeHistory', [q(5n), 'latest', [50]])

export async function estimateGas(base: Rpc, tx: { from: string; to: string; value: bigint }): Promise<bigint | null> {
  try {
    return BigInt(await base.call<string>('eth_estimateGas', [{ from: tx.from, to: tx.to, value: q(tx.value) }]))
  } catch { return null }
}

/** keccak256 of the raw signed bytes = the tx hash. */
export const txHashOf = (rawHex: string): string => '0x' + toHex(keccak_256(fromHex(rawHex)))

export interface Receipt { status: string; blockNumber: string; gasUsed: string }
export const getReceipt = (base: Rpc, hash: string): Promise<Receipt | null> => base.call<Receipt | null>('eth_getTransactionReceipt', [hash])

/** Broadcast; "already known" and "nonce too low" mean an earlier broadcast landed, which is fine. */
export async function sendRaw(base: Rpc, rawHex: string): Promise<{ hash: string; note: string }> {
  const hash = txHashOf(rawHex)
  try {
    await base.call('eth_sendRawTransaction', [rawHex])
    return { hash, note: 'sent' }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/already known|known transaction|nonce too low|already imported/i.test(m)) return { hash, note: 'already-known' }
    throw e
  }
}
