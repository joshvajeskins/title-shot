// NEAR AI prices for the spend ledger: per token for chat models, per image for image models, read from the public
// `GET /v1/models` listing (`pricing.prompt` / `pricing.completion` / `pricing.image`, cached an hour) with a hardcoded
// fallback table when the listing is unreachable or a model has no usable price. All money here is integer nano-USD.
import { cachedJson } from './cache'
import { DEFAULTS, type KVLike } from './env'

/** USD per prompt token, per completion token and per image. */
export interface Price { in: number; out: number; image: number }
export type PriceTable = Record<string, Partial<Price>>

export const NANO = 1_000_000_000 // nano-USD per USD
export const toNano = (usd: number): number => Math.round(usd * NANO)
export const toUsd = (nano: number): number => Math.round(nano) / NANO

export const FALLBACK_PRICES: Record<string, Price> = {
  'z-ai/glm-5.3-flash': { in: 0.08e-6, out: 0.5e-6, image: 0 },
  'black-forest-labs/FLUX.2-klein-4B': { in: 0, out: 0, image: 0.012 },
}
/** A model in neither the listing nor the table is priced high on purpose: an unknown model can never spend cheaply. */
export const UNKNOWN_PRICE: Price = { in: 3e-6, out: 15e-6, image: 0.05 }

/** docs/BUDGET.md: the worst-case cost of one compile (max_tokens 700). Contract forges are charged at this. */
export const WORST_COMPILE_USD = 0.00064
/** Token ceilings per paid call kind (the request's max_tokens and a prompt above the real ~2,710). */
export const WORST_TOKENS = { compile: { in: 3_200, out: 700 }, opener: { in: 400, out: 60 } } as const

export type PaidKind = 'compile' | 'portrait' | 'opener' | 'forge'
export interface Usage { prompt_tokens?: number; completion_tokens?: number; images?: number }

const PRICING_KEY = 'nearai:pricing:v1'
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined // a zero, negative or absurd price is never trusted
}

/** Parse a `/v1/models` listing into a price table (only the fields that carry a usable price). */
export function parseListing(j: unknown): PriceTable {
  const rows = (j as { data?: unknown[] } | null)?.data
  const out: PriceTable = {}
  if (!Array.isArray(rows)) return out
  for (const r of rows) {
    const row = r as { id?: unknown; pricing?: Record<string, unknown> }
    if (typeof row.id !== 'string' || !row.pricing || typeof row.pricing !== 'object') continue
    const p: Partial<Price> = {}
    const pin = num(row.pricing.prompt), pout = num(row.pricing.completion), pimg = num(row.pricing.image)
    if (pin !== undefined) p.in = pin
    if (pout !== undefined) p.out = pout
    if (pimg !== undefined) p.image = pimg
    if (Object.keys(p).length) out[row.id] = p
  }
  return out
}

/** The listing (cached an hour in memory + KV). Never throws: an unreachable listing is an empty table (fallback prices). */
export async function loadPrices(kv: KVLike, fetchFn: typeof fetch): Promise<PriceTable> {
  try {
    return await cachedJson(kv, PRICING_KEY, 3600, async () => {
      const r = await fetchFn(`${DEFAULTS.nearAiBase}/v1/models`)
      if (!r.ok) throw new Error(`models ${r.status}`)
      return parseListing(await r.json())
    })
  } catch { return {} }
}

/** The cached listing only (no network): for read-only status checks. Empty when nothing is cached (fallback prices). */
export async function peekPrices(kv: KVLike): Promise<PriceTable> {
  try { const raw = await kv.get(PRICING_KEY); return raw ? ((JSON.parse(raw) as { value?: PriceTable }).value ?? {}) : {} } catch { return {} }
}

/** Listing first, field by field; then the fallback table; then the deliberately high unknown price. */
export function priceOf(table: PriceTable, model: string): Price {
  const listed = table[model] ?? {}
  const base = FALLBACK_PRICES[model] ?? UNKNOWN_PRICE
  return { in: listed.in ?? base.in, out: listed.out ?? base.out, image: listed.image ?? base.image }
}

/** Worst-case nano-USD of one call of `kind`: what is reserved before it is made. */
export function worstNano(kind: PaidKind, price: Price): number {
  if (kind === 'portrait') return toNano(price.image)
  const t = kind === 'opener' ? WORST_TOKENS.opener : WORST_TOKENS.compile
  const priced = toNano(t.in * price.in + t.out * price.out)
  return kind === 'opener' ? priced : Math.max(priced, toNano(WORST_COMPILE_USD))
}

/** Real nano-USD from the returned usage, or null when the usage is missing or unreadable (the caller then charges worst case). */
export function usageNano(kind: PaidKind, price: Price, u: Usage | null | undefined): number | null {
  if (!u) return null
  if (kind === 'portrait') {
    const n = u.images ?? 0
    return Number.isInteger(n) && n > 0 ? toNano(n * price.image) : null
  }
  const pin = u.prompt_tokens, pout = u.completion_tokens
  if (!Number.isInteger(pin) || !Number.isInteger(pout) || pin! < 0 || pout! < 0) return null
  return toNano(pin! * price.in + pout! * price.out)
}
