// POST /api/boxoffice/challenge: buy a title shot with test USDC on Base Sepolia over x402 v2, then Vance's house books it
// on NEAR (boxofficeBook.ts). Order: validate input -> no payment: 402 offer -> payment: shape and offer checks -> rate
// limits, bookability, sponsor floor -> facilitator /verify -> daily cap -> record -> /settle -> book. Nothing is settled
// for a fight the contract would refuse, and a settled payment is never dropped: its record says what is left to do.
import { z } from 'zod'
import { Basenames } from '../../src/game/chain/basenames'
import { baseAddrUrl, baseTxUrl, txUrl } from '../../src/game/chain/config'
import { messageFor } from '../../src/game/chain/errors'
import { contractCode, RpcError, type Rpc } from '../../src/game/chain/rpc'
import { NEAR, type Signer } from '../../src/game/chain/signer'
import type { RawBelt } from '../../src/game/chain/views'
import { cleanSentence, sentenceProblem } from '../../src/game/client'
import { getJson, putJson, putJsonStrict } from './cache'
import { baseRpcFor, type Chain } from './chain'
import { signerFrom } from './deps'
import { DEFAULTS, type Env, type KVLike } from './env'
import { economicsOf } from './guest'
import { ApiError, json, methodGuard, parseBody } from './http'
import { serialize } from './lane'
import { consume, enforce, KvUnavailable, type Rule } from './ratelimit'
import { book, BookingError, pushRecent, recKey, RECORD_SEC, type PayRecord } from './boxofficeBook'
import { ACCOUNT_STORAGE, findGuest, registerPayout, type GuestCtx } from './boxofficeGuest'
import { beltProblem, bookingProblem, boxConfig, payToOf, type BoxConfig } from './boxofficeQuote'
import {
  authorizationUsed, b64json, checkPayment, decodePayment, FacilitatorDown, PaymentError, paymentHeader, paymentRequired, reasonCode,
  httpFacilitator, requirementsFor, settlementHeaders, txHashOk, type Facilitator, type ReadPayment, type Requirements, type ResourceInfo,
} from './x402'

export const BOX_RULES = {
  ip: { name: 'box-ip', limit: 30, windowSec: 60 },
  payer: { name: 'box-payer', limit: 12, windowSec: 3600 },
} as const satisfies Record<string, Rule>

export const challengeBody = z.object({ belt: z.number().int().min(1).max(10_000), sentence: z.string().min(1).max(400) }).strict()

export interface BoxDeps {
  env: Env; kv: KVLike; chain: Chain; base: Rpc; sponsor: Signer | null; seed: string | null; facilitator: Facilitator; cfg: BoxConfig
  econ: { gas: bigint; floorNear: number }; now: () => number; sleep: (ms: number) => Promise<void>; defer?: (p: Promise<unknown>) => void
  pollMs?: number; resolveMs?: number
}

const closed = () => new ApiError(503, 'BOXOFFICE_CLOSED', 'The box office is closed right now. Challenges in the app still work.')

/** 402 with the offer in PAYMENT-REQUIRED (v2) and in the body, plus { error, code } for humans and older clients. */
function offer(resource: ResourceInfo, req: Requirements, code: string, error: string, extraHeaders: Record<string, string> = {}): Response {
  const pr = paymentRequired(resource, req, error)
  return json({ ...pr, error, code }, 402, { 'payment-required': b64json(pr), 'access-control-expose-headers': 'payment-required, payment-response, x-payment-response', ...extraHeaders })
}

const bookedResponse = (r: PayRecord, replayed: boolean): Response => json({
  challengeId: r.challengeId, nearTx: r.nearTx ?? null, settleTx: r.settleTx ?? null, guest: r.guest, belt: r.belt, payer: r.payer,
  payerName: r.payerName ?? null, sentence: r.sentence, replayed,
  links: { settle: r.settleTx ? baseTxUrl(r.settleTx) : baseAddrUrl(r.payer), challenge: r.nearTx ? txUrl(r.nearTx) : null },
}, 200, settlementHeaders({ transaction: r.settleTx ?? null, payer: r.payer }))

/** The belt, or null when the contract says it does not exist (`get_belt` panics E_NO_BELT); any other failure is a 502. */
async function loadBelt(chain: Chain, id: number): Promise<RawBelt | null> {
  try {
    return await chain.rpc.view<RawBelt>(chain.id, 'get_belt', { id })
  } catch (e) {
    if (e instanceof RpcError && contractCode(e.message) === 'E_NO_BELT') return null
    throw new ApiError(502, 'CHAIN_UNAVAILABLE', 'The chain is not answering. Try again in a moment.')
  }
}

const guestCtx = (d: BoxDeps, toll: bigint): GuestCtx => ({
  near: d.chain.rpc, sponsor: d.sponsor!, contract: d.chain.id, kv: d.kv, seed: d.seed!, toll, gas: d.econ.gas, floorNear: d.econ.floorNear, now: d.now,
})

export async function boxChallenge(d: BoxDeps, request: Request): Promise<Response> {
  methodGuard(request, ['POST'])
  await enforce(d.kv, BOX_RULES.ip, request)
  const body = await parseBody(request, challengeBody)
  const sentence = cleanSentence(body.sentence)
  const problem = sentenceProblem(sentence)
  if (problem) throw new ApiError(400, 'BAD_SENTENCE', problem)
  const req = requirementsFor(await payToOf(d.env, d.chain), d.cfg.amount)
  const url = new URL(request.url)
  const resource = { url: `${url.origin}${url.pathname}`, description: `One title shot on belt ${body.belt} of TITLE SHOT (NEAR): Velvet Vance books your sentence against the champion.`, mimeType: 'application/json' }
  const header = paymentHeader(request)
  if (!header) {
    if (!d.cfg.open) throw closed()
    const p = beltProblem(await loadBelt(d.chain, body.belt), d.now(), sentence)
    if (p) throw new ApiError(p.status, p.code, p.message)
    return offer(resource, req, 'PAYMENT_REQUIRED', `Pay ${d.cfg.usdc} USDC on Base Sepolia to book this title shot.`)
  }
  let pay: ReadPayment
  try { pay = decodePayment(header) } catch (e) { if (e instanceof PaymentError) return offer(resource, req, e.code, e.message); throw e }
  // one payer at a time on this isolate: a double-submit waits for the first and then sees its record
  return serialize(`boxoffice:${pay.payer}`, () => run(d, request, pay, req, resource, body.belt, sentence))
}

async function run(d: BoxDeps, request: Request, pay: ReadPayment, req: Requirements, resource: ResourceInfo, beltId: number, sentence: string): Promise<Response> {
  const key = recKey(d.chain.id, pay.id)
  let r = await getJson<PayRecord>(d.kv, key)
  if (r?.status === 'booked') return bookedResponse(r, true) // a retried request: the stored result, no second booking
  if (!r) {
    try { checkPayment(pay, req, Math.floor(d.now() / 1000)) } catch (e) { if (e instanceof PaymentError) return offer(resource, req, e.code, e.message); throw e }
    if (!d.cfg.open) throw closed()
    if (!d.sponsor || !d.seed) throw closed()
    const belt = await loadBelt(d.chain, beltId)
    const known = await findGuest(d.kv, d.chain.id, pay.payer)
    const p = beltProblem(belt, d.now(), sentence) ?? await bookingProblem(d.chain, belt!, sentence, known?.accountId ?? null)
    if (p) throw new ApiError(p.status, p.code, p.message)
    const need = BigInt(belt!.toll) + (known ? 0n : d.econ.gas + ACCOUNT_STORAGE + NEAR / 100n) // a new corner also needs gas and storage
    const floor = BigInt(Math.round(d.econ.floorNear * 1e6)) * (NEAR / 1_000_000n)
    if ((await d.chain.rpc.balance(d.sponsor.accountId).catch(() => 0n)) < floor + need) throw new ApiError(503, 'SPONSOR_DRY', 'The house cannot front tolls right now. Nothing was charged; try again later.')
    let v
    try { v = await d.facilitator.verify(pay.payload, req) } catch (e) { if (e instanceof FacilitatorDown) throw new ApiError(502, 'FACILITATOR_UNAVAILABLE', 'The payment facilitator is not answering. Nothing was charged; try again.'); throw e }
    if (!v.isValid) return offer(resource, req, 'PAYMENT_INVALID', `The facilitator refused the payment (${reasonCode(v.invalidReason)}). Nothing was charged.`)
    // only a verified signature counts against its payer: forged payloads "from" someone else cannot lock them out
    await enforce(d.kv, BOX_RULES.payer, request, pay.payer)
    await dailyCap(d)
    r = { id: pay.id, status: 'settling', payer: pay.payer, belt: beltId, sentence, at: d.now(), attempt: crypto.randomUUID() }
    try { await putJsonStrict(d.kv, key, r, RECORD_SEC) } catch { throw new ApiError(503, 'BUSY', 'Could not open your booking record. Nothing was charged; try again.', 3) }
  }
  if (r.status === 'settling') {
    const s = await settle(d, pay, req, resource, r)
    if (s instanceof Response) return s
    r = s
  }
  // A held payment books exactly the fight it was paid for. Its header is public once settled (the authorization and signature
  // are in the Base transaction), so a retry carrying a different body must not be able to retarget someone else's shot.
  return finish(d, r, key)
}

/** Settle with the facilitator. A missing or failed answer is checked against the USDC contract before anything is dropped. */
async function settle(d: BoxDeps, pay: ReadPayment, req: Requirements, resource: ResourceInfo, r: PayRecord): Promise<PayRecord | Response> {
  const key = recKey(d.chain.id, r.id)
  let s = null
  try { s = await d.facilitator.settle(pay.payload, req) } catch (e) { if (!(e instanceof FacilitatorDown)) throw e }
  const tx = txHashOk(s?.transaction)
  const used = s?.success ? true : await authorizationUsed(d.base, req.asset, pay.payer, pay.nonce)
  if (used) {
    const next: PayRecord = { ...r, status: 'settled', settleTx: tx }
    await putJsonStrict(d.kv, key, next, RECORD_SEC).catch(() => putJson(d.kv, key, next, RECORD_SEC))
    return next
  }
  if (used === false && s) { // a definite refusal and the authorization is unused: nothing was taken
    await d.kv.delete(key).catch(() => undefined)
    return offer(resource, req, 'PAYMENT_FAILED', `Settlement failed (${reasonCode(s.errorReason)}). Nothing was charged; sign a fresh payment.`)
  }
  throw new ApiError(503, 'SETTLEMENT_PENDING', 'Your payment is still settling on Base. Send the same request again in a few seconds: it will not be charged twice.', 5)
}

async function dailyCap(d: BoxDeps): Promise<void> {
  try {
    const c = await consume(d.kv, { name: 'box-day', limit: d.cfg.dailyMax, windowSec: 86_400 }, 'all', d.now())
    if (!c.ok) throw new ApiError(429, 'DAILY_CAP', 'The box office sold out today. It reopens at midnight UTC. Nothing was charged.', c.retryAfter)
  } catch (e) {
    if (e instanceof KvUnavailable) throw new ApiError(429, 'RATE_LIMITED', 'Busy right now. Nothing was charged; try again in a few seconds.', 3)
    throw e
  }
}

/** The payer's primary Basename (`*.basetest.eth`) for the "challenger from Base" badge: best effort, at most 4 s, else null. */
async function payerName(base: Rpc, addr: string): Promise<string | null> {
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 4000))
  return Promise.race([new Basenames(base).reverse(addr).catch(() => null), timeout])
}

/** The NEAR leg. On failure the payment stays settled and recorded: the same request again resumes it. */
async function finish(d: BoxDeps, r: PayRecord, key: string): Promise<Response> {
  const paid = settlementHeaders({ transaction: r.settleTx ?? null, payer: r.payer })
  const held = `Your payment is held${r.settleTx ? ` (Base tx ${r.settleTx})` : ''}: send the same request with the same payment header to finish it.`
  try {
    const belt = await loadBelt(d.chain, r.belt)
    if (!belt) throw new BookingError('E_NO_BELT', 'That belt does not exist.')
    const g = guestCtx(d, BigInt(belt.toll))
    // relayer mode: 50 Tgas (a corner holding 0.1 NEAR cannot attach 300 Tgas: testnet drops that tx silently)
    const { forge_mode: forgeMode } = await d.chain.config()
    let done = await book({ g, kv: d.kv, key, sleep: d.sleep, pollMs: d.pollMs, resolveMs: d.resolveMs, forgeMode }, r)
    if (done.payerName === undefined) {
      done = { ...done, payerName: await payerName(d.base, r.payer) }
      await putJson(d.kv, key, done, RECORD_SEC)
    }
    await pushRecent(d.kv, d.chain.id, done)
    const guest = await findGuest(d.kv, d.chain.id, r.payer)
    if (guest && !guest.evmSet) { const reg = registerPayout(g, r.payer, guest); if (d.defer) d.defer(reg); else await reg }
    return bookedResponse(done, false)
  } catch (e) {
    const code = e instanceof BookingError ? e.code : e instanceof ApiError ? e.code : 'INTERNAL'
    await putJson(d.kv, key, { ...((await getJson<PayRecord>(d.kv, key)) ?? r), error: code }, RECORD_SEC)
    if (e instanceof BookingError && e.pending) return json({ error: `${e.message} Send the same request again in a few seconds to see the result.`, code: 'BOOKING_PENDING' }, 503, { ...paid, 'retry-after': '5' })
    const why = e instanceof BookingError && code.startsWith('E_') ? messageFor(code) : e instanceof Error && (e instanceof BookingError || e instanceof ApiError) ? e.message : 'The booking hit an error.'
    return json({ error: `${why} ${held}`, code: 'BOOKING_FAILED' }, 502, paid)
  }
}

/** Dependencies from the Pages environment. Custodial corner keys derive from BOXOFFICE_SEED, else from the sponsor key. */
export function boxDeps(env: Env, chain: Chain, defer?: (p: Promise<unknown>) => void): BoxDeps {
  const sponsor = signerFrom(env.SPONSOR_ID ?? DEFAULTS.sponsorId, env.SPONSOR_KEY, chain.rpc)
  const cfg = boxConfig(env)
  const { gas, floorNear } = economicsOf(env)
  return {
    env, kv: env.TS_KV, chain, base: baseRpcFor(env), sponsor, seed: env.BOXOFFICE_SEED || env.SPONSOR_KEY || null,
    facilitator: httpFacilitator(cfg.facilitator), cfg, econ: { gas, floorNear }, now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)), defer,
  }
}
