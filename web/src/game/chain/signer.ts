import { Rpc, RpcError, RpcUnavailable, parseOutcome, type Outcome } from './rpc'
import { formatPublicKey, type KeyPair } from './keys'
import { signTransaction, fn, type Action } from './tx'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const TGAS = 1_000_000_000_000n
export const NEAR = 10n ** 24n

/** Signs and sends transactions for one account/key. Nonces are read from RPC and bumped locally. */
export class Signer {
  private lastNonce = 0n
  constructor(readonly accountId: string, readonly key: KeyPair, readonly rpc: Rpc) {}

  get publicKey(): string { return formatPublicKey(this.key.publicKey) }

  /** Sign and broadcast (async); returns the tx hash. Retries a stale nonce. */
  async send(receiverId: string, actions: Action[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const [chainNonce, blockHash] = await Promise.all([this.rpc.accessKeyNonce(this.accountId, this.publicKey), this.rpc.blockHash()])
      const nonce = (chainNonce > this.lastNonce ? chainNonce : this.lastNonce) + 1n
      this.lastNonce = nonce
      const tx = signTransaction({ signerId: this.accountId, receiverId, nonce, blockHash, actions }, this.key)
      try {
        await this.rpc.sendAsync(tx.base64)
        return tx.hash
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (attempt < 4 && (msg.includes('InvalidNonce') || e instanceof RpcUnavailable)) { await sleep(900); continue }
        throw e
      }
    }
  }

  /** Poll until every receipt executed (or timeout). Never throws on a failed tx: inspect `failure`. */
  async wait(hash: string, timeoutMs = 90_000, waitUntil = 'EXECUTED_OPTIMISTIC'): Promise<Outcome & { raw: any }> {
    const t0 = Date.now()
    let last: unknown = null
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await this.rpc.txStatus(hash, this.accountId, waitUntil)
        if (r?.status && r.status !== 'Unknown') return { ...parseOutcome(r), raw: r }
      } catch (e) {
        last = e
        if (e instanceof RpcError && !/UNKNOWN_TRANSACTION|TIMEOUT|timeout/i.test(e.kind + ' ' + e.message)) throw e
      }
      await sleep(1300)
    }
    throw new Error(`timeout waiting for ${hash}: ${String(last).slice(0, 120)}`)
  }

  async call(receiverId: string, method: string, args: unknown, gas: bigint, deposit = 0n, timeoutMs?: number) {
    const hash = await this.send(receiverId, [fn(method, args, gas, deposit)])
    const out = await this.wait(hash, timeoutMs)
    return { hash, ...out }
  }
}
