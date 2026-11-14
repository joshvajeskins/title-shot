// x402 v2 (https://x402.org) for the box office: the 402 offer, the client's PAYMENT-SIGNATURE header, and the
// facilitator's /verify and /settle. Written against the @x402/core 2.31 wire types (PaymentRequired, PaymentPayload,
// VerifyResponse, SettleResponse) so the Worker needs no SDK. Scheme `exact` on Base Sepolia: an EIP-3009
// transferWithAuthorization of USDC, which the facilitator submits (and pays the gas for). Upstream text never reaches
// a response: facilitator reasons are passed on only as short machine codes.
import { encodeFunctionData, type Hex } from 'viem'
import { z } from 'zod'
import { fromUtf8, toB64, fromB64, utf8 } from '../../src/game/chain/bytes'
import type { Rpc } from '../../src/game/chain/rpc'

export const X402_VERSION = 2
export const NETWORK = 'eip155:84532' // Base Sepolia (CAIP-2)
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
/** EIP-712 domain of Circle's Base Sepolia USDC (name/version are what the client signs over). */
export const USDC_DOMAIN = { name: 'USDC', version: '2' } as const
export const DEFAULT_FACILITATOR = 'https://x402.org/facilitator'
export const MAX_TIMEOUT_SEC = 300
/** The authorization must stay valid at least this long after we receive it: settling takes a few seconds. */
const MIN_VALIDITY_SEC = 20
const MAX_HEADER = 8 * 1024

export interface Requirements {
  scheme: 'exact'; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number
  extra: { name: string; version: string }
}
export interface ResourceInfo { url: string; description: string; mimeType: string }
export interface PaymentRequired { x402Version: number; error?: string; resource: ResourceInfo; accepts: Requirements[] }

/** "0.25" -> "250000" (USDC has 6 decimals). Plain decimals in (0, 5]; anything else is the fallback. */
export function usdcUnits(v: string | undefined, fallback = '250000'): string {
  const m = /^(\d{1,2})(?:\.(\d{1,6}))?$/.exec((v ?? '').trim())
  if (!m) return fallback
  const units = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0')
  return units > 0n && units <= 5_000_000n ? units.toString() : fallback
}
export const formatUsdc = (units: string): string => {
  const n = BigInt(units)
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${n / 1_000_000n}${frac ? '.' + frac : ''}`
}

export const requirementsFor = (payTo: string, amount: string): Requirements => ({
  scheme: 'exact', network: NETWORK, asset: USDC_BASE_SEPOLIA, amount, payTo, maxTimeoutSeconds: MAX_TIMEOUT_SEC, extra: { ...USDC_DOMAIN },
})

export const paymentRequired = (resource: ResourceInfo, req: Requirements, error?: string): PaymentRequired =>
  ({ x402Version: X402_VERSION, ...(error ? { error } : {}), resource, accepts: [req] })

/** Base64 of the UTF-8 JSON: the encoding of PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE. */
export const b64json = (v: unknown): string => toB64(utf8(JSON.stringify(v)))
export const unb64json = (s: string): unknown => JSON.parse(fromUtf8(fromB64(s)))

const hex = (len: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${len}}$`))
const uint = z.string().regex(/^\d{1,78}$/)
export const paymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string().max(500) }).passthrough().optional(),
  accepted: z.object({
    scheme: z.string().max(40), network: z.string().max(80), asset: z.string().max(80), amount: uint, payTo: z.string().max(80),
    maxTimeoutSeconds: z.number().int().nonnegative().optional(), extra: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  payload: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/).min(132).max(4096),
    authorization: z.object({ from: hex(40), to: hex(40), value: uint, validAfter: uint, validBefore: uint, nonce: hex(64) }),
  }).passthrough(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).passthrough()
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>

/** A payment that cannot be used. The endpoint answers 402 with the offer again. */
export class PaymentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 402) { super(message) }
}

export interface ReadPayment { payload: PaymentPayload; payer: string; nonce: string; id: string }

/** The payment header (v2 PAYMENT-SIGNATURE, or the v1 name X-PAYMENT carrying a v2 payload), or null when absent. */
export function paymentHeader(request: Request): string | null {
  return request.headers.get('payment-signature') ?? request.headers.get('x-payment')
}

/** Decode the header into a payment (shape only). Identity: payer + EIP-3009 nonce, one booking per authorization. */
export function decodePayment(header: string): ReadPayment {
  if (header.length > MAX_HEADER || !/^[A-Za-z0-9+/=\s]+$/.test(header)) throw new PaymentError('PAYMENT_MALFORMED', 'The payment header is not base64 JSON.')
  let raw: unknown
  try { raw = unb64json(header.replace(/\s+/g, '')) } catch { throw new PaymentError('PAYMENT_MALFORMED', 'The payment header is not base64 JSON.') }
  const r = paymentPayloadSchema.safeParse(raw)
  if (!r.success) throw new PaymentError('PAYMENT_MALFORMED', 'The payment is not an x402 v2 exact EVM payload.')
  const a = r.data.payload.authorization
  const payer = a.from.toLowerCase()
  const nonce = a.nonce.toLowerCase()
  return { payload: r.data, payer, nonce, id: `${payer}:${nonce}` }
}

/**
 * Check a fresh payment against our offer before anything goes to the facilitator: the client must have accepted exactly
 * our requirements, and the authorization must move exactly the price to exactly our address, and be valid now.
 */
export function checkPayment(pay: ReadPayment, req: Requirements, nowSec: number): void {
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase()
  const acc = pay.payload.accepted
  const a = pay.payload.payload.authorization
  if (acc.scheme !== req.scheme || acc.network !== req.network || !same(acc.asset, req.asset) || acc.amount !== req.amount || !same(acc.payTo, req.payTo)) {
    throw new PaymentError('PAYMENT_MISMATCH', 'The payment does not accept this offer (scheme, network, asset, amount or payTo differ).')
  }
  if (!same(a.to, req.payTo) || a.value !== req.amount) throw new PaymentError('PAYMENT_MISMATCH', 'The authorization does not pay exactly the price to the box office.')
  if (BigInt(a.validAfter) > BigInt(nowSec)) throw new PaymentError('PAYMENT_NOT_YET_VALID', 'The authorization is not valid yet.')
  if (BigInt(a.validBefore) < BigInt(nowSec + MIN_VALIDITY_SEC)) throw new PaymentError('PAYMENT_EXPIRED', 'The authorization has expired or is about to. Sign a fresh one.')
}

// ---- facilitator
export interface VerifyResult { isValid: boolean; invalidReason?: string; payer?: string }
export interface SettleResult { success: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string }
export interface Facilitator {
  verify(p: PaymentPayload, r: Requirements): Promise<VerifyResult>
  settle(p: PaymentPayload, r: Requirements): Promise<SettleResult>
}
/** The facilitator did not give a usable answer (down, timeout, non-JSON). Nothing is known about the payment's state. */
export class FacilitatorDown extends Error {}

const verifySchema = z.object({ isValid: z.boolean(), invalidReason: z.string().optional(), payer: z.string().optional() }).passthrough()
const settleSchema = z.object({ success: z.boolean(), errorReason: z.string().optional(), transaction: z.string().optional(), network: z.string().optional(), payer: z.string().optional() }).passthrough()

/** A facilitator reason as a short code we can show ("insufficient_funds"), never free text. */
export const reasonCode = (s: string | undefined): string => (s && /^[a-z0-9_]{1,64}$/i.test(s) ? s : 'unknown')
export const txHashOk = (s: string | undefined): string | null => (s && /^0x[0-9a-fA-F]{64}$/.test(s) ? s : null)

export function httpFacilitator(url: string, fetchFn: typeof fetch = (...a) => fetch(...a), timeoutMs = 25_000): Facilitator {
  const base = url.replace(/\/+$/, '')
  async function post<T>(op: 'verify' | 'settle', schema: z.ZodType<T>, p: PaymentPayload, r: Requirements): Promise<T> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetchFn(`${base}/${op}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ x402Version: p.x402Version, paymentPayload: p, paymentRequirements: r }),
      })
      const text = await res.text()
      if (text.length > 64 * 1024) throw new FacilitatorDown(`${op}: oversized answer`)
      const parsed = schema.safeParse(JSON.parse(text)) // a 400 with {isValid:false} or {success:false} is an answer, not an outage
      if (!parsed.success) throw new FacilitatorDown(`${op}: HTTP ${res.status} without a result`)
      return parsed.data
    } catch (e) {
      if (e instanceof FacilitatorDown) throw e
      throw new FacilitatorDown(`${op}: unreachable`)
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    verify: (p, r) => post('verify', verifySchema, p, r),
    settle: (p, r) => post('settle', settleSchema, p, r),
  }
}

/** PAYMENT-RESPONSE (v2) and X-PAYMENT-RESPONSE (v1 name) for a settled payment. */
export function settlementHeaders(s: { transaction: string | null; payer: string }): Record<string, string> {
  const v = b64json({ success: true, transaction: s.transaction ?? '', network: NETWORK, payer: s.payer })
  return { 'payment-response': v, 'x-payment-response': v, 'access-control-expose-headers': 'payment-response, x-payment-response, payment-required' }
}

const AUTH_STATE_ABI = [{
  type: 'function', name: 'authorizationState', stateMutability: 'view',
  inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }],
}] as const

/** EIP-3009 `authorizationState(from, nonce)` on the USDC contract: true once that authorization was used. null = unknown. */
export async function authorizationUsed(base: Rpc, asset: string, from: string, nonce: string): Promise<boolean | null> {
  try {
    const data = encodeFunctionData({ abi: AUTH_STATE_ABI, functionName: 'authorizationState', args: [from as Hex, nonce as Hex] })
    const out = await base.call<string>('eth_call', [{ to: asset, data }, 'latest'])
    return /^0x0*1$/.test(out) ? true : /^0x0*$/.test(out) ? false : null
  } catch { return null }
}
