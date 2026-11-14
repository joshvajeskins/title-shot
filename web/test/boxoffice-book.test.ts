// Box office, NEAR leg: a settled payment books exactly one challenge, a retry never books twice, a booking that fails
// after settlement is kept and finished by a retry, and a payer's corner is reused (and its purse address registered).
import { describe, expect, it } from 'vitest'
import { boxChallenge } from '../functions/_lib/boxoffice'
import { recentKey, recKey, type PayRecord } from '../functions/_lib/boxofficeBook'
import { findGuest } from '../functions/_lib/boxofficeGuest'
import { decodePayment } from '../functions/_lib/x402'
import { GAS_CHALLENGE, GAS_CHALLENGE_RELAYER } from '../src/game/chain/config'
import { agent, ask, baseRpc, CONTRACT, deps, facilitator, NEAR, newPayer, payHeader, SETTLE_TX, SPONSOR, world } from './boxoffice-world'

const body = { belt: 1, sentence: 'a retired lighthouse keeper who punches with the tide' }
const record = async (d: ReturnType<typeof deps>, h: string) => JSON.parse((await d.kv.get(recKey(CONTRACT, decodePayment(h).id)))!) as PayRecord

async function paid(opts: Parameters<typeof world>[0] = {}, fac = facilitator()) {
  const w = world(opts)
  const d = deps(w, fac)
  const payer = newPayer()
  const h = await payHeader(await boxChallenge(d, ask(body)), payer)
  return { w, d, fac, payer, h, send: (b: unknown = body, hh = h) => boxChallenge(d, ask(b, { 'payment-signature': hh })) }
}

describe('a paid title shot is booked on NEAR', () => {
  it('first payment: sponsor creates the corner with toll + storage as its first deposit, the session key challenges, the payout address is registered', async () => {
    const { w, d, payer, send } = await paid()
    const r = await send()
    expect(r.status).toBe(200)
    const j = await r.json() as Record<string, any>
    expect(j).toMatchObject({ challengeId: 41, settleTx: SETTLE_TX, belt: 1, payer: payer.address.toLowerCase(), payerName: null, replayed: false })
    expect(j.guest).toMatch(/^[a-z]+-[a-z]+-\d{2}\.play\.titleshot\.testnet$/)
    expect(j.nearTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    expect(j.links.settle).toBe(`https://sepolia.basescan.org/tx/${SETTLE_TX}`)
    expect(w.kinds()).toEqual(['create', 'deposit', 'challenge', 'evm'])
    const [create, deposit, challenge, evm] = w.sent
    expect(create!.signer).toBe(SPONSOR)
    expect(deposit!.signer).toBe(SPONSOR)
    expect(challenge!).toMatchObject({ signer: j.guest, receiver: CONTRACT, belt: 1, sentence: body.sentence })
    expect(evm!).toMatchObject({ signer: j.guest, receiver: CONTRACT })
    // exactly one deposit: the toll (0.05) + the contract's 0.005 NEAR storage reserve, so exactly one toll is credited
    expect(w.sent.filter((t) => t.kind === 'deposit').map((t) => t.deposit)).toEqual([NEAR / 20n + NEAR / 200n])
    const g = await findGuest(d.kv, CONTRACT, payer.address)
    expect(g).toMatchObject({ accountId: j.guest, session: 0, evmSet: true })
    const recent = JSON.parse((await d.kv.get(recentKey(CONTRACT)))!)
    expect(recent[0]).toMatchObject({ challengeId: 41, guest: j.guest, settleTx: SETTLE_TX })
  })

  it('idempotent replay: the same payment header again returns the stored booking; no second settle, deposit or challenge', async () => {
    const { w, fac, h, send } = await paid()
    const first = await (await send()).json() as Record<string, unknown>
    const sentBefore = w.sent.length
    const again = await send()
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ ...first, replayed: true })
    expect(agent.unb64json(again.headers.get('payment-response'))).toMatchObject({ transaction: SETTLE_TX })
    // even with a different body (a replay is the same paid shot, not a new one)
    expect(await (await send({ belt: 1, sentence: 'a different fighter entirely' })).json()).toMatchObject({ challengeId: first.challengeId, replayed: true })
    expect(fac.calls).toEqual({ verify: 1, settle: 1 })
    expect(w.sent.length).toBe(sentBefore)
    expect(h).toBeTruthy()
  })

  it('two simultaneous requests with one payment book once (the payer lane)', async () => {
    const { w, fac, send } = await paid()
    const [a, b] = await Promise.all([send(), send()])
    const ja = await a.json() as { challengeId: number; replayed: boolean }
    const jb = await b.json() as { challengeId: number; replayed: boolean }
    expect(ja.challengeId).toBe(jb.challengeId)
    expect([ja.replayed, jb.replayed].sort()).toEqual([false, true])
    expect(fac.calls.settle).toBe(1)
    expect(w.kinds().filter((k) => k === 'challenge').length).toBe(1)
  })
})

describe('a booking that fails after settlement is kept, never lost', () => {
  it('the contract refuses the challenge: 502 BOOKING_FAILED with PAYMENT-RESPONSE; the record keeps the credit; a retry books without paying or crediting again', async () => {
    const { w, d, fac, h, send } = await paid({ challengeFails: 'E_NO_SEASON' })
    const r = await send()
    expect(r.status).toBe(502)
    const j = await r.json() as { error: string; code: string }
    expect(Object.keys(j).sort()).toEqual(['code', 'error'])
    expect(j.code).toBe('BOOKING_FAILED')
    expect(j.error).toMatch(/no open season.*payment is held/s)
    expect(agent.unb64json(r.headers.get('payment-response'))).toMatchObject({ success: true, transaction: SETTLE_TX })
    expect(await record(d, h)).toMatchObject({ status: 'settled', credited: true, error: 'E_NO_SEASON', settleTx: SETTLE_TX })
    expect((await record(d, h)).challengeTx).toBeUndefined()

    w.opts.challengeFails = undefined // the season opens
    const ok = await send()
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ challengeId: 41, replayed: false })
    expect(fac.calls).toEqual({ verify: 1, settle: 1 })
    expect(w.kinds().filter((k) => k === 'deposit').length).toBe(1)
    expect(w.kinds().filter((k) => k === 'create').length).toBe(1)
  })

  it('a retry cannot retarget a held payment (its header is public on Base once settled): it books the fight that was paid for', async () => {
    const { w, send } = await paid({ challengeFails: 'E_NO_SEASON' })
    expect((await send()).status).toBe(502)
    w.opts.challengeFails = undefined
    const r = await send({ belt: 1, sentence: 'a goose who studied contract law at night' })
    expect(await r.json()).toMatchObject({ challengeId: 41, sentence: body.sentence })
    expect(w.sent.filter((t) => t.kind === 'challenge').every((t) => t.sentence === body.sentence)).toBe(true)
  })

  it('the toll credit fails: BOOKING_FAILED, the payment stays settled; a retry credits and books', async () => {
    const w = world()
    const fac = facilitator()
    const d = deps(w, fac)
    const payer = newPayer()
    // corner exists already (an earlier shot), so this payment needs its own deposit_for
    const h1 = await payHeader(await boxChallenge(d, ask(body)), payer)
    expect((await boxChallenge(d, ask(body, { 'payment-signature': h1 }))).status).toBe(200)
    w.pending.clear()
    w.opts.depositFails = true
    const h2 = await payHeader(await boxChallenge(d, ask(body)), payer)
    const r = await boxChallenge(d, ask(body, { 'payment-signature': h2 }))
    expect(r.status).toBe(502)
    expect(await record(d, h2)).toMatchObject({ status: 'settled', error: 'E_STORAGE' })
    expect((await record(d, h2)).credited).toBeUndefined()
    w.opts.depositFails = false
    const ok = await boxChallenge(d, ask(body, { 'payment-signature': h2 }))
    expect(ok.status).toBe(200)
    expect(fac.calls.settle).toBe(2) // one per payment, never a second for the retry
  })
})

describe('the challenge transaction', () => {
  it('attaches the gas of the contract\'s forge mode: 50 Tgas in relayer mode (a 0.1 NEAR corner cannot attach 300), 300 Tgas in OutLayer mode', async () => {
    const relayer = await paid({ forgeMode: 'relayer' })
    expect((await relayer.send()).status).toBe(200)
    expect(relayer.w.sent.filter((t) => t.kind === 'challenge').map((t) => t.gas)).toEqual([GAS_CHALLENGE_RELAYER])
    const outlayer = await paid({ forgeMode: 'outlayer' })
    expect((await outlayer.send()).status).toBe(200)
    expect(outlayer.w.sent.filter((t) => t.kind === 'challenge').map((t) => t.gas)).toEqual([GAS_CHALLENGE])
  })

  it('a broadcast the RPC accepted but that never landed is resent AT THE SAME NONCE (so both can never land) and books once', async () => {
    const { w, d, h, send } = await paid({ dropChallenges: 1 })
    const r = await send()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ challengeId: 41 })
    const sends = w.sent.filter((t) => t.kind === 'challenge')
    expect(sends.length).toBe(2)
    expect(sends[0]!.nonce).toBe(sends[1]!.nonce) // the scripted key nonce is 10: both signed at 11
    expect(sends[0]!.nonce).toBe(11n)
    expect(await record(d, h)).toMatchObject({ status: 'booked', challengeNonce: '11', challengeKey: 0, nearTx: sends[1]!.hash })
  })

  it('a record stranded on a lost broadcast (an earlier request gave up) is finished by the retry, at the recorded nonce', async () => {
    const { w, d, h, send } = await paid({ dropChallenges: 2 })
    const first = await send()
    expect(first.status).toBe(503)
    expect(await first.json()).toMatchObject({ code: 'BOOKING_PENDING' })
    expect(w.sent.filter((t) => t.kind === 'challenge').length).toBe(2) // the send and one same-nonce resend, both lost
    const ok = await send()
    expect(ok.status).toBe(200)
    expect(new Set(w.sent.filter((t) => t.kind === 'challenge').map((t) => t.nonce))).toEqual(new Set([11n]))
    expect((await record(d, h)).status).toBe('booked')
  })

  it('a session key out of gas allowance is replaced by a fresh one (full key adds it) and the challenge goes through', async () => {
    const { w, d, payer, send } = await paid({ allowanceOut: 1 })
    expect((await send()).status).toBe(200)
    expect(w.kinds()).toEqual(['create', 'deposit', 'challenge', 'addkey', 'challenge', 'evm'])
    expect(await findGuest(d.kv, CONTRACT, payer.address)).toMatchObject({ session: 1 })
  })
})

describe('one corner per payer', () => {
  it('a second payment from the same Base address reuses the corner: no new account, one deposit_for of exactly the toll', async () => {
    const w = world()
    const d = deps(w, facilitator())
    const payer = newPayer()
    const h1 = await payHeader(await boxChallenge(d, ask(body)), payer)
    const first = await (await boxChallenge(d, ask(body, { 'payment-signature': h1 }))).json() as { guest: string }
    w.pending.clear() // the first fight resolved
    const h2 = await payHeader(await boxChallenge(d, ask(body)), payer)
    const second = await boxChallenge(d, ask({ belt: 1, sentence: 'a walrus in a borrowed tuxedo' }, { 'payment-signature': h2 }))
    expect(await second.json()).toMatchObject({ guest: first.guest, challengeId: 42 })
    expect(w.kinds()).toEqual(['create', 'deposit', 'challenge', 'evm', 'deposit', 'challenge'])
    expect(w.sent[4]!.deposit).toBe(NEAR / 20n) // a returning corner gets exactly one toll, no storage
    const another = newPayer()
    const h3 = await payHeader(await boxChallenge(d, ask(body)), another)
    const third = await (await boxChallenge(d, ask(body, { 'payment-signature': h3 }))).json() as { guest: string }
    expect(third.guest).not.toBe(first.guest)
  })

  it('a payer whose last fight is still forging is told to wait before paying again (nothing settled)', async () => {
    const w = world()
    const fac = facilitator()
    const d = deps(w, fac)
    const payer = newPayer()
    const h1 = await payHeader(await boxChallenge(d, ask(body)), payer)
    await boxChallenge(d, ask(body, { 'payment-signature': h1 }))
    const h2 = await payHeader(await boxChallenge(d, ask(body)), payer)
    const e = await boxChallenge(d, ask(body, { 'payment-signature': h2 })).catch((x) => x)
    expect(e).toMatchObject({ status: 409, code: 'PENDING' })
    expect(fac.calls.settle).toBe(1)
  })

  it('house limits are checked before settlement: a dry sponsor and the daily cap refuse with nothing charged', async () => {
    const dry = world()
    dry.accounts[SPONSOR] = NEAR / 2n
    const fac = facilitator()
    const d = deps(dry, fac)
    const h = await payHeader(await boxChallenge(d, ask(body)), newPayer())
    expect(await boxChallenge(d, ask(body, { 'payment-signature': h })).catch((x) => x)).toMatchObject({ status: 503, code: 'SPONSOR_DRY' })
    const capped = deps(world(), fac, baseRpc({ used: false }))
    capped.cfg = { ...capped.cfg, dailyMax: 0 }
    const h2 = await payHeader(await boxChallenge(capped, ask(body)), newPayer())
    expect(await boxChallenge(capped, ask(body, { 'payment-signature': h2 })).catch((x) => x)).toMatchObject({ status: 429, code: 'DAILY_CAP' })
    expect(fac.calls.settle).toBe(0)
  })

  it('BOXOFFICE_OFF closes the box office before any payment is asked for', async () => {
    const d = deps(world(), facilitator())
    d.cfg = { ...d.cfg, open: false }
    expect(await boxChallenge(d, ask(body)).catch((x) => x)).toMatchObject({ status: 503, code: 'BOXOFFICE_CLOSED' })
  })
})
