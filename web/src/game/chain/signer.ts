import { Rpc, RpcError, RpcUnavailable, parseOutcome, type Outcome } from './rpc'
import { formatPublicKey, type KeyPair } from './keys'
import { signTransaction, fn, type Action } from './tx'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const TGAS = 1_000_000_000_000n
export const NEAR = 10n ** 24n

// Shared by every Signer of the same key in this isolate, so the guest endpoint, the bell and the expiry sweep (which all
// use the sponsor key) never hand out the same nonce while an earlier transaction is still unconfirmed.
const lastNonces = new Map<string, bigint>()

/** Signs and sends transactions for one account/key. Nonces are read from RPC and bumped locally. */
export class Signer {
  private get lastNonce(): bigint { return lastNonces.get(this.nonceKey) ?? 0n }
  private set lastNonce(n: bigint) { lastNonces.set(this.nonceKey, n) }
  private get nonceKey(): string { return `${this.accountId}|${this.publicKey}` }
  constructor(readonly accountId: string, readonly key: KeyPair, readonly rpc: Rpc) {}

  get publicKey(): string { return formatPublicKey(this.key.publicKey) }

  /**
   * Sign and broadcast (async); returns the tx hash.
   * - RpcUnavailable (every node failed): the tx may or may not have landed, so the SAME signed bytes are sent again; the
   *   chain deduplicates by hash, so this can never pay twice.
   * - InvalidNonce: the nonce is stale, so a new tx is signed, unless one of our own sends is what took the nonce (an earlier
   *   send that looked failed): each hash we sent is looked up first, and a hit is returned instead of signing again.
   */
  async send(receiverId: string, actions: Action[]): Promise<string> {
    let tx: ReturnType<typeof signTransaction> | null = null
    const ambiguous: string[] = [] // hashes whose broadcast ended in RpcUnavailable
    for (let attempt = 0; ; attempt++) {
      if (!tx) {
        const [chainNonce, blockHash] = await Promise.all([this.rpc.accessKeyNonce(this.accountId, this.publicKey), this.rpc.blockHash()])
        const nonce = (chainNonce > this.lastNonce ? chainNonce : this.lastNonce) + 1n
        this.lastNonce = nonce
        tx = signTransaction({ signerId: this.accountId, receiverId, nonce, blockHash, actions }, this.key)
      }
      try {
        await this.rpc.sendAsync(tx.base64)
        return tx.hash
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (attempt >= 4) throw e
        if (e instanceof RpcUnavailable) {
          if (!ambiguous.includes(tx.hash)) ambiguous.push(tx.hash)
          await sleep(900)
          continue // same bytes again
        }
        if (msg.includes('InvalidNonce')) {
          // our own tx may be what took the nonce (an earlier send that "failed", or one node timing out while another got it)
          for (const h of [...new Set([...ambiguous, tx.hash])]) {
            const landed = await this.landed(h)
            if (landed === true) return h
            if (landed === null) throw e // cannot tell whether our earlier send landed: never sign a second tx on a guess
          }
          tx = null
          await sleep(900)
          continue
        }
        throw e
      }
    }
  }

  /** Does the chain know this tx (any status)? null when that cannot be determined. */
  private async landed(hash: string): Promise<boolean | null> {
    try {
      const r = await this.rpc.txStatus(hash, this.accountId, 'NONE')
      return !!r && (!!r.transaction || !!r.final_execution_status || !!r.status)
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_TRANSACTION|TIMEOUT|timeout/i.test(`${e.kind} ${e.message}`)) return false
      if (e instanceof RpcUnavailable && /TIMEOUT/.test(e.message)) return false // nodes answer an unknown hash with a timeout
      return null
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
