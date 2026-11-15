import { describe, expect, it } from 'vitest'
import { assessHealth, healthStep, HEALTH_EVERY_MS, type HealthInput } from '../functions/_lib/health'
import { getJson, scoped } from '../functions/_lib/cache'
import { HEALTH_MAX_AGE_MS, healthLines, type Health, type HealthKey } from '../src/game/health'
import type { TickDeps } from '../functions/_lib/tickTypes'
import { belt, CONTRACT, NOW_MS } from './fixtures'
import { env, TEST_DERIVED_KEY } from './helpers'

const NEAR = 10n ** 24n
const milli = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n
const TOLL = (NEAR / 20n).toString() // 0.05 NEAR, as live
const FEE = (NEAR / 100n).toString() // 0.01 NEAR
const live = () => [
  belt({ id: 1, toll: TOLL, forge_fee: FEE, holder: 'house-a.titleshot.testnet' }),
  belt({ id: 2, name: 'The Tide Belt', toll: TOLL, forge_fee: FEE, holder: 'vance.titleshot.testnet' }),
  belt({ id: 3, name: 'The Wildcard Belt', toll: TOLL, forge_fee: FEE, holder: 'house-a.titleshot.testnet' }),
]

/** The funding Gabriel reported on 15 Nov: house ~2.5 NEAR each, play 6.6, vance 1.67 NEAR + 0.11 ETH, $0.95 of a $1.00 day. */
const today = (over: Partial<HealthInput> = {}): HealthInput => ({
  now: NOW_MS, belts: live(),
  house: [{ account: 'house-a.titleshot.testnet', balance: milli(2.5) }, { account: 'house-b.titleshot.testnet', balance: milli(2.5) }],
  sponsorYocto: milli(6.59), vanceYocto: milli(1.671), vanceWei: 110_166_891_725_826_585n,
  forge: { open: true, reason: null, resetsAt: null, spentUsd: 0.43, budgetUsd: 2.5, publicLeftUsd: 0.945 },
  caps: { daily: 60, total: 250, today: 9, used: 51, day: 0 },
  params: { houseEveryMs: 40 * 60_000, seasonSec: 10_800, purseWei: 2_000_000_000_000_000n, demoAccountYocto: milli(0.4), sponsorFloorNear: 0.8, publicDailyUsd: 1 },
  ...over,
})
const levels = (h: Health) => Object.fromEntries(h.checks.map((c) => [c.key, c.level])) as Record<HealthKey, string>
const one = (h: Health, k: HealthKey) => h.checks.find((c) => c.key === k)!

describe('runway thresholds', () => {
  it('today’s funding covers a day of everything: every check is ok and no banner shows', () => {
    const h = assessHealth(today())
    expect(levels(h)).toEqual({ promoter_eth: 'ok', promoter_near: 'ok', house: 'ok', sponsor: 'ok', forge: 'ok' })
    expect(healthLines(h, NOW_MS)).toEqual([])
    // the numbers behind it: 8 rounds x 3 purses of 0.002 ETH (+ L1 reserve + gas) ~ 0.048 ETH a day against 0.11 held
    expect(one(h, 'promoter_eth').dayNeed).toBeCloseTo(0.04874, 4)
    // house: 36 challenges a day per idle belt; two belts held by the house return their champion share
    expect(one(h, 'house').dayNeed).toBeCloseTo(36 * (0.05 - 0.6 * 0.037) * 2 + 36 * 0.05, 3)
    expect(one(h, 'sponsor').dayNeed).toBeCloseTo(0.8 + 10 * 0.4 + 0.2, 6)
  })

  it('house: below a day of challenges is low, unable to pay the next toll + fee is out ("House fighters resting")', () => {
    expect(one(assessHealth(today({ house: [{ account: 'house-a.titleshot.testnet', balance: milli(1.5) }, { account: 'house-b.titleshot.testnet', balance: milli(1.5) }] })), 'house').level).toBe('low')
    const dry = assessHealth(today({ house: [{ account: 'house-a.titleshot.testnet', balance: milli(0.05) }, { account: 'house-b.titleshot.testnet', balance: milli(0.059) }] }))
    expect(one(dry, 'house').level).toBe('out')
    expect(healthLines(dry, NOW_MS)[0]!.text).toMatch(/^House fighters resting/)
    // nothing to challenge: no runway needed
    expect(one(assessHealth(today({ belts: [], house: [{ account: 'house-a.titleshot.testnet', balance: 0n }] })), 'house').level).toBe('ok')
  })

  it('demo sponsor: out below the SPONSOR_DRY floor, low below a day of demo accounts', () => {
    expect(one(assessHealth(today({ sponsorYocto: milli(4) })), 'sponsor').level).toBe('low')
    const dry = assessHealth(today({ sponsorYocto: milli(0.79) }))
    expect(one(dry, 'sponsor').level).toBe('out')
    expect(healthLines(dry, NOW_MS).map((l) => l.text)).toEqual(['Judge demo accounts are refilling: connect a wallet to play now.'])
  })

  it('promoter: ETH below one purse pauses the purse; NEAR below fee + open gas pauses the next season', () => {
    expect(one(assessHealth(today({ vanceWei: 30_000_000_000_000_000n })), 'promoter_eth').level).toBe('low')
    const noEth = assessHealth(today({ vanceWei: 400_000_000_000_000n }))
    expect(one(noEth, 'promoter_eth').level).toBe('out')
    expect(healthLines(noEth, NOW_MS)[0]!.text).toBe('Purse paused, refilling: season purses resume shortly.')
    expect(one(assessHealth(today({ vanceYocto: milli(0.3) })), 'promoter_near').level).toBe('low')
    expect(one(assessHealth(today({ vanceYocto: milli(0.039) })), 'promoter_near').level).toBe('out')
  })

  it('forge: out when the public budget or the contract cap is shut today, low under 20 worst-case compiles', () => {
    const shut = assessHealth(today({ forge: { open: false, reason: 'public_daily', resetsAt: '2026-11-16T00:00:00.000Z', spentUsd: 1, budgetUsd: 2.5, publicLeftUsd: 0 } }))
    expect(one(shut, 'forge').level).toBe('out')
    expect(shut.forgeResetsAt).toBe('2026-11-16T00:00:00.000Z')
    expect(healthLines(shut, NOW_MS)[0]!.text).toMatch(/^Today’s forge budget is spent/)
    expect(one(assessHealth(today({ caps: { daily: 60, total: 250, today: 60, used: 120, day: 0 } })), 'forge').level).toBe('out')
    expect(one(assessHealth(today({ forge: { ...today().forge!, publicLeftUsd: 0.01 } })), 'forge').level).toBe('low')
    expect(one(assessHealth(today({ caps: { daily: 60, total: 250, today: 57, used: 120, day: 0 } })), 'forge').level).toBe('low')
  })

  it('unreadable balances are unknown, never a banner; a stale record shows nothing', () => {
    const h = assessHealth(today({ sponsorYocto: null, vanceWei: null, forge: null, caps: null }))
    expect(levels(h)).toMatchObject({ sponsor: 'unknown', promoter_eth: 'unknown', forge: 'unknown' })
    expect(healthLines(h, NOW_MS)).toEqual([])
    const dry = assessHealth(today({ sponsorYocto: milli(0.1) }))
    expect(healthLines(dry, NOW_MS + HEALTH_MAX_AGE_MS + 1)).toEqual([])
  })

  it('banner order: what already stops something comes first', () => {
    const h = assessHealth(today({ sponsorYocto: milli(4), vanceWei: 1n }))
    expect(healthLines(h, NOW_MS).map((l) => [l.key, l.level])).toEqual([['promoter_eth', 'out'], ['sponsor', 'low']])
  })
})

describe('the tick step', () => {
  const deps = (now: { t: number }) => {
    const e = env({ CONTRACT_ID: CONTRACT, SPONSOR_ID: 'play.titleshot.testnet', VANCE_ID: 'vance.titleshot.testnet', HOUSE_EVERY_MIN: '40', SEASON_SEC: '10800', PURSE_WEI: '2000000000000000', NEARAI_PUBLIC_DAILY_USD: '1', COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: '11'.repeat(32) })
    const reads: string[] = []
    const d = {
      env: e, now: () => now.t, mpc: 'v1.signer-prod.testnet',
      chain: { id: CONTRACT, config: async () => ({ model_id: 'z-ai/glm-5.3-flash', forge_mode: 'relayer' }), view: async (m: string, a: { account: string }) => { reads.push(`${m}:${a.account}`); return (2n * NEAR).toString() }, compileCaps: async () => ({ daily: 60, total: 250, today: 9, used: 51, day: 0 }) },
      near: { balance: async (id: string) => { reads.push(`near:${id}`); return id.startsWith('play') ? milli(6.6) : milli(1.67) }, view: async () => TEST_DERIVED_KEY },
      base: { call: async () => '0x' + (110_000_000_000_000_000n).toString(16) },
    } as unknown as TickDeps
    return { d, reads, e }
  }
  it('reads every balance, stores one record in KV for /api/state, and does not re-read within two minutes', async () => {
    const now = { t: NOW_MS }
    const { d, reads, e } = deps(now)
    const h = await healthStep(d, live())
    expect(reads.sort()).toEqual(['balance_of:house-a.titleshot.testnet', 'balance_of:house-b.titleshot.testnet', 'near:play.titleshot.testnet', 'near:vance.titleshot.testnet'])
    expect(h && levels(h)).toEqual({ promoter_eth: 'ok', promoter_near: 'ok', house: 'ok', sponsor: 'ok', forge: 'ok' })
    expect(await getJson<Health>(e.TS_KV, scoped(CONTRACT, 'health:v1'))).toEqual(h)
    now.t += HEALTH_EVERY_MS - 1
    expect(await healthStep(d, live())).toBeNull()
    now.t += 2
    expect(await healthStep(d, live())).not.toBeNull()
  })
  it('a failing read becomes unknown instead of failing the tick', async () => {
    const { d } = deps({ t: NOW_MS })
    ;(d.near as { balance: unknown }).balance = async () => { throw new Error('HTTP 429') }
    const h = (await healthStep(d, live()))!
    expect(levels(h)).toMatchObject({ sponsor: 'unknown', promoter_near: 'unknown' })
    expect(healthLines(h, NOW_MS)).toEqual([])
  })
})
