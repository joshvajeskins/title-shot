// Vance funds each season's purse from its own Chain-Signatures Base Sepolia address (path "vance-purse").
// The tx is built with viem, signed by the MPC network (v1.signer-prod.testnet) when Vance calls `sign`, then broadcast.
import { keccak256, recoverTransactionAddress, serializeTransaction, type Hex } from 'viem'
import { Signer, TGAS } from '../../src/game/chain/signer'
import { Rpc } from '../../src/game/chain/rpc'
import { BASE_CHAIN_ID, getBalance, getFeeHistory, getNonce, getReceipt, sendRaw, deriveEvmAddress, txHashOf } from './evm'
import { feeParams } from './fees'

export const VANCE_PATH = 'vance-purse'
const TRANSFER_GAS = 21_000n

export interface Eip1559Tx { type: 'eip1559'; chainId: number; nonce: number; to: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

/** keccak256 of the unsigned EIP-1559 bytes: what the MPC network signs. */
export const txDigest = (tx: Eip1559Tx): Hex => keccak256(serializeTransaction(tx))
export const signedRaw = (tx: Eip1559Tx, sig: MpcSignature): Hex => serializeTransaction(tx, sig)
export const recoverSigner = (raw: Hex): Promise<string> => recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })

export interface MpcSignature { r: Hex; s: Hex; yParity: 0 | 1 }

/** The signer's response: {"scheme":"Secp256k1","big_r":{"affine_point":"03<x>"},"s":{"scalar":"<hex>"},"recovery_id":N}. */
export function parseMpcSignature(v: unknown): MpcSignature {
  const o = v as { big_r?: { affine_point?: string }; s?: { scalar?: string }; recovery_id?: number } | null
  const point = o?.big_r?.affine_point
  const scalar = o?.s?.scalar
  const rec = o?.recovery_id
  if (!point || !scalar || (rec !== 0 && rec !== 1) || point.length !== 66 || scalar.length !== 64) throw new Error('bad MPC signature response')
  return { r: `0x${point.slice(2)}`, s: `0x${scalar}`, yParity: rec }
}

export async function mpcSign(signer: Signer, mpcContract: string, path: string, digestHex: string): Promise<MpcSignature> {
  const hash = await signer.send(mpcContract, [
    { kind: 'functionCall', method: 'sign', args: new TextEncoder().encode(JSON.stringify({ request: { payload_v2: { Ecdsa: digestHex.replace(/^0x/, '') }, path, domain_id: 0 } })), gas: 300n * TGAS, deposit: 1n },
  ])
  const out = await signer.wait(hash, 120_000)
  if (out.failure) throw new Error(`signer failed: ${out.failure.slice(0, 120)}`)
  return parseMpcSignature(out.value)
}

export interface FundResult { ok: boolean; code?: string; txHash?: string; address: string; balanceWei: string; purseWei?: string; detail?: string }

/** Smallest purse worth opening a season with (0.0005 ETH). */
export const MIN_PURSE_WEI = 500_000_000_000_000n

export interface FundDeps { near: Rpc; base: Rpc; vance: Signer; mpc: string }

/** Decide how much Vance can put in a purse: the configured amount, scaled down to what its address holds. */
export function pursePlan(balance: bigint, want: bigint, maxFee: bigint): { purse: bigint; ok: boolean } {
  const gasCost = TRANSFER_GAS * maxFee
  const available = balance > gasCost ? balance - gasCost : 0n
  const purse = available < want ? available : want
  return { purse, ok: purse >= MIN_PURSE_WEI }
}

/** Saved BEFORE the broadcast, with the raw tx: a tick killed anywhere after signing re-broadcasts the same tx (same nonce) instead of funding twice. */
export interface SavedFunding { hash: string; purse: string; raw?: string }

async function waitReceipt(base: Rpc, hash: string, tries = 25): Promise<'ok' | 'reverted' | 'pending'> {
  for (let i = 0; i < tries; i++) {
    const r = await getReceipt(base, hash).catch(() => null)
    if (r) return r.status === '0x1' ? 'ok' : 'reverted'
    await new Promise((res) => setTimeout(res, 1000))
  }
  return 'pending'
}

/**
 * Send `want` wei (or what is affordable) from Vance's MPC address to the season's purse address.
 * `saved` is a funding tx an earlier tick already broadcast for this purse: it is awaited, never re-sent.
 */
export async function fundPurse(d: FundDeps, purseAddr: string, want: bigint, saved?: SavedFunding | null, save?: (s: SavedFunding) => Promise<void>): Promise<FundResult> {
  const from = await deriveEvmAddress(d.near, d.mpc, VANCE_PATH, d.vance.accountId)
  if (saved) {
    // the earlier tick may have died before (or while) broadcasting: send the identical tx again (known/nonce-too-low are fine)
    if (saved.raw && !(await getReceipt(d.base, saved.hash).catch(() => null))) await sendRaw(d.base, saved.raw).catch(() => undefined)
    const st = await waitReceipt(d.base, saved.hash, 8)
    const base = { txHash: saved.hash, address: from, balanceWei: '0', purseWei: saved.purse }
    return st === 'ok' ? { ok: true, ...base } : { ok: false, code: st === 'reverted' ? 'FUND_REVERTED' : 'FUND_PENDING', ...base }
  }
  const balance = await getBalance(d.base, from)
  const fees = feeParams(await getFeeHistory(d.base))
  const plan = pursePlan(balance, want, fees.maxFee)
  if (!plan.ok) return { ok: false, code: 'VANCE_DRY', address: from, balanceWei: balance.toString(), detail: `fund ${from} on Base Sepolia` }
  const nonce = await getNonce(d.base, from)
  const tx: Eip1559Tx = { type: 'eip1559', chainId: BASE_CHAIN_ID, nonce: Number(nonce), to: purseAddr as Hex, value: plan.purse, gas: TRANSFER_GAS, maxFeePerGas: fees.maxFee, maxPriorityFeePerGas: fees.priority }
  const digest = txDigest(tx)
  const sig = await mpcSign(d.vance, d.mpc, VANCE_PATH, digest)
  const raw = signedRaw(tx, sig)
  const recovered = await recoverSigner(raw)
  if (recovered.toLowerCase() !== from.toLowerCase()) return { ok: false, code: 'SIG_MISMATCH', address: from, balanceWei: balance.toString() }
  const hash = txHashOf(raw)
  // Save BEFORE broadcasting, and only broadcast once the record is really stored: with no record, a retry could fund a second time.
  try { await save?.({ hash, purse: plan.purse.toString(), raw }) } catch { return { ok: false, code: 'FUND_SAVE_FAILED', address: from, balanceWei: balance.toString(), detail: 'not broadcast; retried next tick' } }
  await sendRaw(d.base, raw)
  const st = await waitReceipt(d.base, hash)
  const base = { txHash: hash, address: from, balanceWei: balance.toString(), purseWei: plan.purse.toString() }
  return st === 'ok' ? { ok: true, ...base } : { ok: false, code: st === 'reverted' ? 'FUND_REVERTED' : 'FUND_PENDING', ...base }
}
