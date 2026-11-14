import { describe, expect, it } from 'vitest'
import { belt, challenge, fighter, fightRow, NOW_MS, ns, season } from './fixtures'
import { run, setup, world, type Call, type World } from './tick-rig'
import { checkArgs } from './contract-abi'
import { getJson } from '../functions/_lib/cache'
import { capsLeaveRoom, houseSeats, markKey, recentKey, type HouseDeps, type HouseSeat } from '../functions/_lib/house'
import { HOUSE_NPCS, HOUSE_PERSONAS } from '../functions/_lib/houseNpcs'
import { openerOk } from '../functions/_lib/opener'
import { sentenceProblem } from '../src/game/client'
import { formatSecretKey, generateKeyPair } from '../src/game/chain/keys'
import type { CompileCaps } from '../functions/_lib/chain'
import type { RawBelt } from '../src/game/chain/views'

const A = 'house-a.titleshot.testnet', B = 'house-b.titleshot.testnet'
const MIN = 60_000
const RICH = 10n ** 24n
const AI_SENTENCE = 'a parking warden who tickets the referee mid-bout'

interface Opts { balances?: Record<string, bigint>; pending?: string[]; lastFightMinAgo?: number; caps?: Partial<CompileCaps>; cached?: string[]; chat?: 'ok' | 'fail' }

function houseWorld(over: Partial<World> = {}, o: Opts = {}) {
  const chats: string[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/chat/completions')) {
      chats.push(String(init?.body ?? ''))
      if (o.chat === 'fail') return new Response('upstream down', { status: 500 })
      return new Response(JSON.stringify({ choices: [{ message: { content: AI_SENTENCE } }], usage: { prompt_tokens: 120, completion_tokens: 14 } }))
    }
    return new Response('no network in tests', { status: 500 })
  }) as unknown as typeof fetch
  const w = world({ forgeMode: 'relayer', ...over })
  const r = setup(w, { relayer: false, fetchFn })
  const d = r.d as HouseDeps
  d.env.NEARAI_API_KEY = 'k'
  const seat = (npc: (typeof HOUSE_NPCS)[number]): HouseSeat => ({
    npc,
    signer: {
      accountId: npc.id,
      call: async (receiver: string, method: string, args: any, _gas: bigint, deposit = 0n) => {
        checkArgs(method, args)
        r.calls.push({ who: npc.id, receiver, method, args, deposit })
        return { hash: `tx-${r.calls.length}`, failure: w.failures[`${npc.id}:${method}`] ?? null, value: 9, logs: [], events: [], status: 'SuccessValue', raw: {} }
      },
    } as unknown as HouseSeat['signer'],
  })
  d.house = HOUSE_NPCS.map(seat)
  Object.assign(d.chain, {
    view: async (m: string, a: any) => {
      checkArgs(m, a)
      if (m === 'balance_of') return String(o.balances?.[a.account] ?? RICH)
      if (m === 'get_pending') return o.pending?.includes(a.account) ? challenge({ challenger: a.account }) : null
      throw new Error('no view ' + m)
    },
    fights: async () => (o.lastFightMinAgo === undefined ? [] : [fightRow(1, 0, 1, { at: ns(NOW_MS - o.lastFightMinAgo * MIN) })]),
    compileCaps: async () => ({ daily: 60, total: 250, today: 4, used: 4, day: 20771, ...o.caps }),
    fighterBySentence: async (s: string) => (o.cached?.includes(s) ? fighter(2) : null),
  })
  return { ...r, w, d, chats }
}

const idle = (over: Partial<RawBelt> = {}, ago = 90) => belt({ season: season({ opens_at: ns(NOW_MS - ago * MIN) }), ...over })
const houseCalls = (calls: Call[]) => calls.filter((c) => c.who.startsWith('house-'))

describe('house challengers: cadence', () => {
  it('challenges a belt idle for longer than HOUSE_EVERY_MIN with a fresh NEAR AI sentence', async () => {
    const { d, calls, kv, chats } = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 30 })
    const log = await run(d)
    const hc = houseCalls(calls)
    expect(hc).toHaveLength(1)
    expect(hc[0]).toMatchObject({ receiver: 'titleshot.testnet', method: 'challenge', args: { belt_id: 1, sentence: AI_SENTENCE }, deposit: 0n })
    expect(chats).toHaveLength(1)
    expect(chats[0]).toContain(belt().champion!.sentence) // the prompt names the champion to beat
    const step = log.steps.find((s) => s.action.startsWith('house_challenge'))!
    expect(step).toMatchObject({ belt: 1, ok: true })
    expect(step.detail).toContain('(nearai)')
    expect(await getJson(kv, recentKey(d))).toEqual([AI_SENTENCE])
    expect(await getJson(kv, markKey(d, 1))).toBe(NOW_MS)
  })
  it('waits while the belt saw a bout (or opened) within the cadence; HOUSE_EVERY_MIN changes it', async () => {
    const recentBout = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 10 })
    await run(recentBout.d)
    expect(houseCalls(recentBout.calls)).toEqual([])
    const justOpened = houseWorld({ belts: [idle({ fights: 0 }, 12)] })
    await run(justOpened.d)
    expect(houseCalls(justOpened.calls)).toEqual([])
    const fast = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 10 })
    fast.d.env.HOUSE_EVERY_MIN = '5'
    await run(fast.d)
    expect(houseCalls(fast.calls)).toHaveLength(1)
  })
})

describe('house challengers: never while something is pending or the season is not playable', () => {
  it('a pending challenge on the belt, a closed season, a season about to close or no champion: no house challenge', async () => {
    const cases: RawBelt[] = [
      idle({ season: season({ pending: 1, opens_at: ns(NOW_MS - 90 * MIN) }) }),
      idle({ season: season({ state: 'Closed', opens_at: ns(NOW_MS - 90 * MIN) }) }),
      idle({ season: season({ opens_at: ns(NOW_MS - 90 * MIN), closes_at: ns(NOW_MS + 2 * MIN) }) }),
      idle({ champion: null }),
    ]
    for (const b of cases) {
      const { d, calls } = houseWorld({ belts: [b] }, { lastFightMinAgo: 60 })
      await run(d)
      expect(houseCalls(calls)).toEqual([])
    }
  })
  it('the holder and an NPC with its own pending challenge sit out; the other NPC goes', async () => {
    const holderA = houseWorld({ belts: [idle({ holder: A })] }, { lastFightMinAgo: 60 })
    await run(holderA.d)
    expect(houseCalls(holderA.calls).map((c) => c.who)).toEqual([B])
    const pendingB = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, pending: [B], balances: { [A]: RICH / 2n, [B]: RICH } })
    await run(pendingB.d)
    expect(houseCalls(pendingB.calls).map((c) => c.who)).toEqual([A])
    const neither = houseWorld({ belts: [idle({ holder: A })] }, { lastFightMinAgo: 60, pending: [B] })
    await run(neither.d)
    expect(houseCalls(neither.calls)).toEqual([])
  })
})

describe('house challengers: no double challenge', () => {
  it('one house challenge per tick, and the KV marker keeps a belt quiet until the cadence has passed again', async () => {
    const two = [idle({ id: 1 }, 120), idle({ id: 2, token_id: 'belt-2' }, 90)]
    const { d, w, calls } = houseWorld({ belts: two })
    await run(d)
    expect(houseCalls(calls).map((c) => c.args.belt_id)).toEqual([1]) // the stalest belt first
    w.now += 30_000
    await run(d)
    expect(houseCalls(calls).map((c) => c.args.belt_id)).toEqual([1, 2])
    w.now += 30_000
    await run(d)
    expect(houseCalls(calls)).toHaveLength(2) // both belts marked: nothing until 25 min later
    w.now += 25 * MIN
    await run(d)
    expect(houseCalls(calls).map((c) => c.args.belt_id)).toEqual([1, 2, 1])
  })
  it('a refused challenge still holds the marker (no retry storm), and its sentence is not remembered', async () => {
    const { d, w, calls, kv } = houseWorld({ belts: [idle()], failures: { [`${A}:challenge`]: 'Smart contract panicked: E_FORGE_CLOSED', [`${B}:challenge`]: 'Smart contract panicked: E_FORGE_CLOSED' } }, { lastFightMinAgo: 60 })
    const log = await run(d)
    expect(log.steps.find((s) => s.action.startsWith('house_challenge'))).toMatchObject({ ok: false, detail: 'E_FORGE_CLOSED' })
    w.now += 60_000
    await run(d)
    expect(houseCalls(calls)).toHaveLength(1)
    expect(await getJson(kv, recentKey(d))).toBeNull()
  })
})

describe('house challengers: money and NEAR AI budget', () => {
  it('a dry NPC logs HOUSE_DRY and does not challenge; the one with money goes', async () => {
    const need = BigInt(belt().toll) + BigInt(belt().forge_fee)
    const bothDry = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, balances: { [A]: need - 1n, [B]: 0n } })
    const log = await run(bothDry.d)
    expect(houseCalls(bothDry.calls)).toEqual([])
    expect(log.steps.filter((s) => s.detail?.startsWith('HOUSE_DRY')).map((s) => s.action)).toEqual(['house:a', 'house:b'])
    const oneDry = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, balances: { [A]: 0n, [B]: need } })
    await run(oneDry.d)
    expect(houseCalls(oneDry.calls).map((c) => c.who)).toEqual([B])
  })
  it('ledger closed: no NEAR AI call, an already forged house fighter plays; none forged -> HOUSE_FORGE_CLOSED, marker set', async () => {
    const forged = HOUSE_NPCS[0]!.fallback[3]!
    const closed = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, cached: [forged], balances: { [A]: RICH, [B]: 1n + BigInt(belt().toll) + BigInt(belt().forge_fee) } })
    closed.d.env.NEARAI_BUDGET_USD = '0'
    const log = await run(closed.d)
    expect(closed.chats).toEqual([])
    expect(houseCalls(closed.calls).map((c) => [c.who, c.args.sentence])).toEqual([[A, forged]])
    expect(log.steps.find((s) => s.action.startsWith('house_challenge'))!.detail).toContain('(cached)')
    const none = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60 })
    none.d.env.NEARAI_BUDGET_USD = '0'
    const log2 = await run(none.d)
    expect(houseCalls(none.calls)).toEqual([])
    expect(log2.steps.find((s) => s.detail?.startsWith('HOUSE_FORGE_CLOSED'))).toBeTruthy()
    expect(await getJson(none.kv, markKey(none.d, 1))).toBe(NOW_MS)
  })
  it('NEAR AI failing (budget open) falls back to the NPC curated list', async () => {
    const { d, calls } = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, chat: 'fail', balances: { [A]: RICH, [B]: RICH / 2n } })
    const log = await run(d)
    expect(houseCalls(calls).map((c) => c.args.sentence)).toEqual([HOUSE_NPCS[0]!.fallback[0]])
    expect(log.steps.find((s) => s.action.startsWith('house_challenge'))!.detail).toContain('(fallback)')
  })
  it('past half of the daily compile cap the house only fields forged fighters (players keep the rest)', async () => {
    expect(capsLeaveRoom({ daily: 60, total: 250, today: 29, used: 100, day: 1 })).toBe(true)
    expect(capsLeaveRoom({ daily: 60, total: 250, today: 30, used: 100, day: 1 })).toBe(false)
    expect(capsLeaveRoom({ daily: 60, total: 250, today: 1, used: 188, day: 1 })).toBe(false)
    expect(capsLeaveRoom(null)).toBe(true)
    const { d, calls, chats } = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, caps: { today: 31 } })
    const log = await run(d)
    expect(chats).toEqual([])
    expect(houseCalls(calls)).toEqual([])
    expect(log.steps.find((s) => s.detail?.startsWith('HOUSE_FORGE_CLOSED'))).toBeTruthy()
  })
})

describe('house challengers: daily compile allowance', () => {
  it('after HOUSE_COMPILES_PER_DAY new fighters the house re-fields its forged ones (no NEAR AI, no compile)', async () => {
    const { d, w, calls, chats } = houseWorld({ belts: [idle()] }, { lastFightMinAgo: 60, cached: [AI_SENTENCE] })
    d.env.HOUSE_COMPILES_PER_DAY = '1'
    await run(d)
    w.now += 26 * MIN
    const log = await run(d)
    expect(chats).toHaveLength(1)
    expect(houseCalls(calls).map((c) => c.args.sentence)).toEqual([AI_SENTENCE, AI_SENTENCE])
    expect(log.steps.find((s) => s.action.startsWith('house_challenge'))!.detail).toContain('(cached)')
  })
})

describe('house challengers: wiring', () => {
  it('without HOUSE_*_KEY secrets there is no house (and the tick is unchanged)', async () => {
    const { d, calls } = setup(world({ belts: [idle()] }))
    const log = await run(d)
    expect(houseCalls(calls)).toEqual([])
    expect(log.steps.filter((s) => s.action.startsWith('house'))).toEqual([])
  })
  it('seats come from the function-call key secrets, account ids overridable', () => {
    const { d } = setup(world())
    d.env.HOUSE_A_KEY = formatSecretKey(generateKeyPair())
    d.env.HOUSE_B_KEY = 'not a key'
    d.env.HOUSE_A_ID = 'house-a.staging.testnet'
    expect(houseSeats(d as HouseDeps).map((s) => [s.npc.key, s.signer.accountId])).toEqual([['a', 'house-a.staging.testnet']])
  })
  it('personas are exported for the UI (no keys) and every curated sentence is a valid sentence', () => {
    expect(HOUSE_PERSONAS.map((p) => Object.keys(p).sort())).toEqual([['bio', 'id', 'key', 'name'], ['bio', 'id', 'key', 'name']])
    expect(HOUSE_PERSONAS.map((p) => p.id)).toEqual([A, B])
    for (const s of HOUSE_NPCS.flatMap((n) => n.fallback)) {
      expect(sentenceProblem(s)).toBeNull()
      expect(openerOk(s)).toBe(true)
    }
  })
})
