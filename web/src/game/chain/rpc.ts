// JSON-RPC client with ordered failover, view helpers and outcome parsing. Runtime-neutral (fetch only).
import { fromB64, fromUtf8 } from './bytes'

export const DEFAULT_RPC_URLS = [
  'https://near-testnet.drpc.org',
  'https://test.rpc.fastnear.com',
  'https://rpc.testnet.fastnear.com',
  'https://testnet-rpc.intea.rs',
]

export class RpcError extends Error {
  constructor(message: string, readonly kind: string, readonly raw: unknown) {
    super(message)
  }
}
export class RpcUnavailable extends Error {}

export interface RpcOptions { urls?: string[]; fetchFn?: typeof fetch; timeoutMs?: number }

export class Rpc {
  private urls: string[]
  private fetchFn: typeof fetch
  private timeoutMs: number
  private preferred = 0
  private id = 0

  constructor(opts: RpcOptions = {}) {
    this.urls = opts.urls?.length ? opts.urls : DEFAULT_RPC_URLS
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a))
    this.timeoutMs = opts.timeoutMs ?? 12000
  }

  async call<T = any>(method: string, params: unknown): Promise<T> {
    let lastErr: unknown = null
    for (let i = 0; i < this.urls.length; i++) {
      const idx = (this.preferred + i) % this.urls.length
      try {
        const out = await this.callOne<T>(this.urls[idx]!, method, params)
        this.preferred = idx
        return out
      } catch (e) {
        if (e instanceof RpcError) throw e // a definitive answer from the node: do not fail over
        lastErr = e
      }
    }
    throw new RpcUnavailable(`RPC unavailable: ${String(lastErr).slice(0, 160)}`)
  }

  private async callOne<T>(url: string, method: string, params: unknown): Promise<T> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: ctl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`)
    let json: any
    try { json = await res.json() } catch { throw new Error('non-JSON RPC response') }
    if (json.error) {
      const cause = json.error.cause?.name ?? json.error.name ?? 'UNKNOWN'
      if (json.error.code === -429 || /rate limit/i.test(String(json.error.message))) throw new Error('rate limited')
      if (['TIMEOUT_ERROR', 'INTERNAL_ERROR', 'UNAVAILABLE_SHARD', 'NOT_SYNCED_YET'].includes(cause)) throw new Error(`transient ${cause}`)
      throw new RpcError(json.error.data ? String(JSON.stringify(json.error.data)).slice(0, 400) : String(json.error.message), cause, json.error)
    }
    return json.result as T
  }

  /** Call a view method; returns parsed JSON (or null for empty). */
  async view<T = any>(contractId: string, method: string, args: unknown = {}): Promise<T> {
    const r = await this.call<{ result?: number[]; error?: string }>('query', {
      request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    })
    if (r.error) throw new RpcError(r.error, 'CONTRACT_VIEW', r)
    const text = fromUtf8(Uint8Array.from(r.result ?? []))
    return (text === '' ? null : JSON.parse(text)) as T
  }

  async balance(accountId: string): Promise<bigint> {
    const r = await this.call<{ amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId })
    return BigInt(r.amount)
  }

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    const r = await this.call<{ nonce: number | string }>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey })
    return BigInt(r.nonce)
  }

  async blockHash(): Promise<string> {
    const b = await this.call<{ header: { hash: string } }>('block', { finality: 'final' })
    return b.header.hash
  }

  async sendAsync(signedBase64: string): Promise<void> {
    await this.call('send_tx', { signed_tx_base64: signedBase64, wait_until: 'NONE' })
  }

  async txStatus(hash: string, senderId: string, waitUntil = 'EXECUTED_OPTIMISTIC'): Promise<any> {
    return this.call('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: waitUntil })
  }
}

export interface Outcome {
  /** top-level failure message, or null when every receipt succeeded */
  failure: string | null
  /** SuccessValue of the first function call (parsed JSON), if any */
  value: unknown
  logs: string[]
  events: { standard?: string; event: string; data: any }[]
  status: string
}

/** Flatten a `tx` RPC result into the pieces the game cares about. */
export function parseOutcome(r: any): Outcome {
  const logs: string[] = []
  let failure: string | null = null
  for (const o of r?.receipts_outcome ?? []) {
    logs.push(...(o.outcome?.logs ?? []))
    const st = o.outcome?.status
    if (st && typeof st === 'object' && 'Failure' in st && !failure) failure = describeFailure(st.Failure)
  }
  const top = r?.status
  if (top && typeof top === 'object' && 'Failure' in top) failure = describeFailure(top.Failure)
  let value: unknown = undefined
  if (top && typeof top === 'object' && 'SuccessValue' in top) {
    const raw = String(top.SuccessValue ?? '')
    try { value = raw === '' ? null : JSON.parse(fromUtf8(fromB64(raw))) } catch { value = undefined }
  }
  const events: Outcome['events'] = []
  for (const l of logs) {
    if (!l.startsWith('EVENT_JSON:')) continue
    try { events.push(JSON.parse(l.slice('EVENT_JSON:'.length))) } catch { /* ignore */ }
  }
  const status = typeof top === 'string' ? top : top && typeof top === 'object' ? Object.keys(top)[0]! : 'Unknown'
  return { failure, value, logs, events, status }
}

/** The contract's stable `E_...` code inside a failure, if present. */
export function contractCode(message: string | null | undefined): string | null {
  const m = /\bE_[A-Z_]+\b/.exec(message ?? '')
  return m ? m[0] : null
}

function describeFailure(f: any): string {
  const s = JSON.stringify(f)
  return s.length > 500 ? s.slice(0, 500) : s
}
