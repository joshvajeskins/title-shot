// Box office (x402 v2 on Base Sepolia): the 402 offer, input validation, and what happens when the facilitator refuses,
// fails or does not answer. Booking, replay and corner reuse: boxoffice-book.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boxChallenge } from '../functions/_lib/boxoffice'
import { recKey } from '../functions/_lib/boxofficeBook'
import { usdcUnits, formatUsdc, decodePayment, checkPayment, requirementsFor, USDC_BASE_SEPOLIA, b64json } from '../functions/_lib/x402'
import { onRequest as challengeApi } from '../functions/api/boxoffice/challenge'
import { onRequest as quoteApi } from '../functions/api/boxoffice/quote'
import { ctx, env } from './helpers'
import { agent, ask, baseRpc, beltFixture, CHAMP, CONTRACT, deps, facilitator, newPayer, payHeader, SETTLE_TX, VANCE_ADDR, world } from './boxoffice-world'

const SENTENCE = 'a retired lighthouse keeper who punches with the tide'
const body = { belt: 1, sentence: SENTENCE }

describe('the 402 offer (x402 v2)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST without a payment: 402 with PAYMENT-REQUIRED = exact USDC on Base Sepolia to Vance, and { error, code } in the body', async () => {
    const w = world()
    vi.stubGlobal('fetch', w.rpc.fetchFn) // the real endpoint wiring, on the scripted chain
    const r = await challengeApi(ctx(ask(body), env({ CONTRACT_ID: CONTRACT })))
    expect(r.status).toBe(402)
    const pr = agent.unb64json(r.headers.get('payment-required'))
    expect(pr).toMatchObject({ x402Version: 2, resource: { url: 'https://t.test/api/boxoffice/challenge', mimeType: 'application/json' } })
    expect(pr.accepts).toEqual([{ scheme: 'exact', network: 'eip155:84532', asset: USDC_BASE_SEPOLIA, amount: '250000', payTo: VANCE_ADDR, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }])
    const j = await r.json() as Record<string, unknown>
    expect(j).toMatchObject({ code: 'PAYMENT_REQUIRED', x402Version: 2 })
    expect(typeof j.error).toBe('string')
    expect(r.headers.get('access-control-expose-headers')).toContain('payment-required')
    expect(w.sent).toEqual([]) // asking costs nothing
  })

  it('the agent accepts the offer, and refuses one that pays someone else or costs more than its limit', async () => {
    const r = await boxChallenge(deps(world(), facilitator()), ask(body))
    const pr = agent.unb64json(r.headers.get('payment-required'))
    expect(agent.pickRequirements(pr, { maxUnits: 1_000_000n, payTo: VANCE_ADDR }).amount).toBe('250000')
    expect(() => agent.pickRequirements(pr, { maxUnits: 1_000_000n, payTo: '0x' + '1'.repeat(40) })).toThrow(/different address/)
    expect(() => agent.pickRequirements(pr, { maxUnits: 100_000n, payTo: VANCE_ADDR })).toThrow(/above/)
  })

  it('GET /api/boxoffice/quote: price, payTo, contract, the honest rate note, and the belt with its champion', async () => {
    const w = world()
    vi.stubGlobal('fetch', w.rpc.fetchFn)
    const r = await quoteApi(ctx(new Request('https://t.test/api/boxoffice/quote?belt=1'), env({ CONTRACT_ID: CONTRACT, BOXOFFICE_PRICE_USDC: '0.5' })))
    expect(r.status).toBe(200)
    const q = await r.json() as any
    expect(q).toMatchObject({ contract: CONTRACT, payTo: VANCE_ADDR, network: 'eip155:84532', price: { usdc: '0.5', amount: '500000' }, belt: { id: 1, bookable: true, toll: { near: '0.05' }, champion: { sentence: CHAMP } } })
    expect(q.rate).toMatch(/fixed rate \(no swap\)/)
    expect((await quoteApi(ctx(new Request('https://t.test/api/boxoffice/quote?belt=x'), env({ CONTRACT_ID: CONTRACT })))).status).toBe(400)
  })

  it('price parsing: plain decimals in (0, 5] USDC, anything else falls back to 0.25', () => {
    expect(usdcUnits('0.25')).toBe('250000')
    expect(usdcUnits('1')).toBe('1000000')
    for (const bad of ['', 'abc', '0', '-1', '5.000001', '1e3', '0.1234567']) expect(usdcUnits(bad), bad).toBe('250000')
    expect(formatUsdc('250000')).toBe('0.25')
  })
})

describe('bad input never reaches the facilitator', () => {
  const cases: [string, () => Request, number, string][] = [
    ['not JSON', () => ask('{nope'), 400, 'BAD_JSON'],
    ['extra field', () => ask({ ...body, admin: true }), 400, 'BAD_INPUT'],
    ['belt 0', () => ask({ belt: 0, sentence: SENTENCE }), 400, 'BAD_INPUT'],
    ['belt as text', () => ask({ belt: '1', sentence: SENTENCE }), 400, 'BAD_INPUT'],
    ['sentence too short', () => ask({ belt: 1, sentence: 'ab' }), 400, 'BAD_SENTENCE'],
    ['invisible characters', () => ask({ belt: 1, sentence: 'a sneaky​ goose' }), 400, 'BAD_SENTENCE'],
    ['the champion\'s own sentence', () => ask({ belt: 1, sentence: `  ${CHAMP} ` }), 409, 'SAME_SENTENCE'],
    ['a belt that does not exist (the contract panics E_NO_BELT)', () => ask({ belt: 99, sentence: SENTENCE }), 404, 'NO_BELT'],
    ['GET', () => new Request('https://t.test/api/boxoffice/challenge'), 405, 'METHOD_NOT_ALLOWED'],
  ]
  for (const [name, req, status, code] of cases) {
    it(`${name}: ${status} ${code}`, async () => {
      const fac = facilitator()
      const r = await boxChallenge(deps(world(), fac), req()).catch((e) => e)
      const res = r instanceof Response ? r : null
      const got = res ? { status: res.status, code: ((await res.json()) as { code: string }).code } : { status: r.status, code: r.code }
      expect(got).toEqual({ status, code })
      expect(fac.calls).toEqual({ verify: 0, settle: 0 })
    })
  }

  it('a closed season is refused before any payment is asked for', async () => {
    const e = await boxChallenge(deps(world({ belt: { season: { ...beltFixture().season, state: 'Closed' } } }), facilitator()), ask(body)).catch((x) => x)
    expect(e).toMatchObject({ status: 409, code: 'NO_SEASON' })
  })

  it('malformed, mismatched and expired payments: 402 with the offer again, nothing verified or settled', async () => {
    const w = world()
    const fac = facilitator()
    const d = deps(w, fac)
    const offer = await boxChallenge(d, ask(body))
    const payer = newPayer()
    const now = Math.floor(Date.now() / 1000)
    const tampered = agent.unb64json(await payHeader(offer, payer))
    tampered.payload.authorization.value = '1'
    const wrongTo = agent.unb64json(await payHeader(offer, payer))
    wrongTo.accepted.payTo = '0x' + '2'.repeat(40)
    const headers: [string, string][] = [
      ['%%%', 'PAYMENT_MALFORMED'],
      [b64json({ hello: 'world' }), 'PAYMENT_MALFORMED'],
      [b64json(tampered), 'PAYMENT_MISMATCH'],
      [b64json(wrongTo), 'PAYMENT_MISMATCH'],
      [await payHeader(offer, payer, { nowSec: now - 600 }), 'PAYMENT_EXPIRED'],
    ]
    for (const [h, code] of headers) {
      const r = await boxChallenge(d, ask(body, { 'payment-signature': h }))
      expect(r.status, code).toBe(402)
      expect(((await r.json()) as { code: string }).code).toBe(code)
      expect(r.headers.get('payment-required')).toBeTruthy()
    }
    expect(fac.calls).toEqual({ verify: 0, settle: 0 })
    expect(w.sent).toEqual([])
  })

  it('decodePayment/checkPayment accept the agent\'s payload and the v1 header name X-PAYMENT', async () => {
    const d = deps(world(), facilitator())
    const offer = await boxChallenge(d, ask(body))
    const h = await payHeader(offer, newPayer())
    const p = decodePayment(h)
    expect(p.id).toMatch(/^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/)
    expect(() => checkPayment(p, requirementsFor(VANCE_ADDR, '250000'), Math.floor(Date.now() / 1000))).not.toThrow()
    const r = await boxChallenge(d, ask(body, { 'x-payment': h }))
    expect(r.status).toBe(200)
  })
})

describe('facilitator failures', () => {
  const pay = async (fac: ReturnType<typeof facilitator>, used: boolean | null = false) => {
    const w = world()
    const d = deps(w, fac, baseRpc({ used }))
    const h = await payHeader(await boxChallenge(d, ask(body)), newPayer())
    return { w, d, h, r: await boxChallenge(d, ask(body, { 'payment-signature': h })) }
  }

  it('verify says invalid: 402 PAYMENT_INVALID with the facilitator\'s reason code, no settle, no record, nothing on NEAR', async () => {
    const fac = facilitator({ verify: { isValid: false, invalidReason: 'insufficient_funds' } })
    const { w, d, h, r } = await pay(fac)
    expect(r.status).toBe(402)
    expect(await r.json()).toMatchObject({ code: 'PAYMENT_INVALID', error: expect.stringContaining('insufficient_funds') })
    expect(fac.calls).toEqual({ verify: 1, settle: 0 })
    expect(await d.kv.get(recKey(CONTRACT, decodePayment(h).id))).toBeNull()
    expect(w.sent).toEqual([])
  })

  it('refused payments do not count against their claimed payer: 13 forged payloads, then the real one still books', async () => {
    const fac = facilitator({ verify: { isValid: false, invalidReason: 'invalid_exact_evm_signature' } })
    const d = deps(world(), fac)
    const offer = await boxChallenge(d, ask(body))
    const victim = newPayer()
    for (let i = 0; i < 13; i++) expect((await boxChallenge(d, ask(body, { 'payment-signature': await payHeader(offer, victim) }))).status).toBe(402)
    fac.o.verify = undefined // the victim's own, valid payment
    expect((await boxChallenge(d, ask(body, { 'payment-signature': await payHeader(offer, victim) }))).status).toBe(200)
  })

  it('a free-text reason is never echoed (only short machine codes pass)', async () => {
    const { r } = await pay(facilitator({ verify: { isValid: false, invalidReason: 'RPC <html> stack at line 3' } }))
    expect(((await r.json()) as { error: string }).error).toContain('(unknown)')
  })

  it('verify unreachable: 502 FACILITATOR_UNAVAILABLE, nothing charged', async () => {
    const fac = facilitator({ verify: 'down' })
    const { r } = await pay(fac).catch((e) => ({ r: e }))
    expect(r).toMatchObject({ status: 502, code: 'FACILITATOR_UNAVAILABLE' })
    expect(fac.calls.settle).toBe(0)
  })

  it('settle refused and the authorization unused on chain: 402 PAYMENT_FAILED, the record is dropped, NEAR untouched', async () => {
    const fac = facilitator({ settle: { success: false, errorReason: 'invalid_transaction_state', transaction: '', network: 'eip155:84532' } })
    const { w, d, h, r } = await pay(fac, false)
    expect(r.status).toBe(402)
    expect(await r.json()).toMatchObject({ code: 'PAYMENT_FAILED' })
    expect(await d.kv.get(recKey(CONTRACT, decodePayment(h).id))).toBeNull()
    expect(w.sent).toEqual([])
  })

  it('settle gives no answer and the chain cannot tell: 503 SETTLEMENT_PENDING, the record stays; the retry finds it used and books', async () => {
    const fac = facilitator({ settle: 'down' })
    const state = { used: null as boolean | null }
    const w = world()
    const d = deps(w, fac, baseRpc(state))
    const h = await payHeader(await boxChallenge(d, ask(body)), newPayer())
    const e = await boxChallenge(d, ask(body, { 'payment-signature': h })).catch((x) => x)
    expect(e).toMatchObject({ status: 503, code: 'SETTLEMENT_PENDING' })
    expect(JSON.parse((await d.kv.get(recKey(CONTRACT, decodePayment(h).id)))!)).toMatchObject({ status: 'settling' })
    expect(w.sent).toEqual([])
    state.used = true // the facilitator's tx did land
    const r = await boxChallenge(d, ask(body, { 'payment-signature': h }))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ challengeId: 41, settleTx: null })
    expect(fac.calls.verify).toBe(1) // the resumed request does not verify (or count against the cap) again
  })

  it('settle succeeds: PAYMENT-RESPONSE and X-PAYMENT-RESPONSE carry the Base tx', async () => {
    const { r } = await pay(facilitator())
    expect(r.status).toBe(200)
    const pr = agent.unb64json(r.headers.get('payment-response'))
    expect(pr).toMatchObject({ success: true, transaction: SETTLE_TX, network: 'eip155:84532' })
    expect(r.headers.get('x-payment-response')).toBe(r.headers.get('payment-response'))
  })
})
