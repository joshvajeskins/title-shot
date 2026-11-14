// Two-layer cache: per-isolate memory in front of KV. Memory is fresh for `ttlSec`; KV is shared across isolates and
// may serve a slightly older value (`kvTtlSec`) so a lobby burst costs a handful of KV writes, not one per request.
import type { KVLike } from './env'

const mem = new Map<string, { exp: number; value: unknown }>()

export async function cachedJson<T>(kv: KVLike, key: string, ttlSec: number, load: () => Promise<T>, kvTtlSec = ttlSec, now = Date.now()): Promise<T> {
  const m = mem.get(key)
  if (m && m.exp > now) return m.value as T
  try {
    const raw = await kv.get(key)
    if (raw) {
      const { at, value } = JSON.parse(raw) as { at: number; value: T }
      if (at + kvTtlSec * 1000 > now) { mem.set(key, { exp: now + ttlSec * 1000, value }); return value }
    }
  } catch { /* a cold or broken KV must not break the request */ }
  const value = await load()
  mem.set(key, { exp: now + ttlSec * 1000, value })
  try { await kv.put(key, JSON.stringify({ at: now, value }), { expirationTtl: Math.max(60, kvTtlSec) }) } catch { /* ignore */ }
  return value
}

export function clearMemoryCache() { mem.clear() }

export async function getJson<T>(kv: KVLike, key: string): Promise<T | null> {
  try { const r = await kv.get(key); return r ? (JSON.parse(r) as T) : null } catch { return null }
}
export async function putJson(kv: KVLike, key: string, value: unknown, ttlSec?: number): Promise<void> {
  try { await kv.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: Math.max(60, ttlSec) } : undefined) } catch { /* ignore */ }
}
/** Like putJson but a failed write throws: for records that must exist before an irreversible step (a broadcast). */
export async function putJsonStrict(kv: KVLike, key: string, value: unknown, ttlSec?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: Math.max(60, ttlSec) } : undefined)
}
/**
 * The KV key of state that belongs to one contract. Staging and production share one KV namespace, and payout and challenge
 * ids restart at 1 on every new contract, so every tick record and contract-derived cache is prefixed with the contract id.
 */
export const scoped = (contract: string | null | undefined, key: string): string => (contract ? `${contract}:${key}` : key)
