// Runway health (src/game/health.ts): on each tick, is every account the game spends from funded for about one day of
// use? Pure assessment (`assessHealth`, unit-tested thresholds) plus the tick step that reads the balances and stores one
// small record in KV for /api/state. Reads only: nothing here sends a transaction.
import type { RawBelt } from '../../src/game/chain/views'
import type { Health, HealthCheck, HealthLevel } from '../../src/game/health'
import { getJson, putJson } from './cache'
import type { CompileCaps } from './chain'
import { deriveEvmAddress, getBalance } from './evm'
import { DEFAULTS } from './env'
import { economicsOf } from './guest'
import { everyMs, HOUSE_NPCS } from './house'
import { limitsOf, type ForgeStatus } from './ledger'
import { forgeStatus } from './ledgerStatus'
import { toUsd, WORST_COMPILE_USD } from './pricing'
import { L1_FEE_RESERVE_WEI, MIN_PURSE_WEI, VANCE_PATH } from './purse'
import { purseWeiOf, seasonSecOf } from './tickOpen'
import { tickKey, type TickDeps } from './tickTypes'

const NEAR = 1e24
const ETH = 1e18
const DAY_MS = 86_400_000
/** The champion's share of what is left of a toll after the forge fee and the bout's storage (docs/CONTRACT.md). */
export const HOLDER_SHARE = 0.6
/** A bout's storage charge, about 260 bytes (docs/CHEAT-RESULTS.md: 0.0026 NEAR); rounded up. */
export const BOUT_STORAGE_NEAR = 0.003
/** Judge demo accounts the sponsor should be able to fund in a day, plus its own bell gas (close_season, expiries). */
export const DEMO_ACCOUNTS_PER_DAY = 10
export const SPONSOR_BELL_GAS_NEAR_PER_DAY = 0.2
/** What Vance spends in NEAR per season it opens: forge fee is read from the belt; gas for open_season, the MPC sign and
 *  set_purse_address, rounded up from testnet receipts. Below fee + 0.03 NEAR the tick refuses to open (VANCE_NEAR_DRY). */
export const OPEN_GAS_NEAR = 0.01
export const OPEN_FLOOR_GAS_NEAR = 0.03
/** Base Sepolia gas for a purse transfer: 21000 gas at a generous 1 gwei. */
export const PURSE_GAS_WEI = 21_000n * 1_000_000_000n
/** The forge is "low" with fewer than this many worst-case compiles left in today's public budget. */
export const FORGE_LOW_COMPILES = 20
export const HEALTH_EVERY_MS = 120_000
const RECORD_SEC = 3 * 3600

export interface HealthInput {
  now: number
  belts: RawBelt[]
  /** house NPC game balances (yocto), null when unreadable */
  house: { account: string; balance: bigint | null }[]
  sponsorYocto: bigint | null
  vanceYocto: bigint | null
  vanceWei: bigint | null
  forge: ForgeStatus | null
  caps: CompileCaps | null
  params: {
    houseEveryMs: number; seasonSec: number; purseWei: bigint
    demoAccountYocto: bigint; sponsorFloorNear: number; publicDailyUsd: number
  }
}

const level = (have: number | null, floor: number, dayNeed: number): HealthLevel =>
  have === null ? 'unknown' : have < floor ? 'out' : have < dayNeed ? 'low' : 'ok'
const near = (y: bigint | null) => (y === null ? null : Number(y) / NEAR)
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d
const check = (key: HealthCheck['key'], have: number | null, floor: number, dayNeed: number, unit: HealthCheck['unit']): HealthCheck =>
  ({ key, level: level(have, floor, dayNeed), have: round(have ?? 0, unit === 'ETH' ? 5 : 4), dayNeed: round(dayNeed, unit === 'ETH' ? 5 : 4), floor: round(floor, unit === 'ETH' ? 5 : 4), unit })

const openBelts = (belts: RawBelt[]) => belts.filter((b) => b.season?.state === 'Open' && b.champion)

/**
 * House NPCs: an idle open belt gets one house challenge per `houseEveryMs`. Each costs the house its toll, minus the
 * champion's share when the holder is itself a house NPC (that share comes back to the house). The next challenge needs
 * toll + forge fee in one NPC's balance (house.ts pickSeat).
 */
export function houseCheck(i: HealthInput): HealthCheck {
  const belts = openBelts(i.belts)
  const npcs = new Set(i.house.map((h) => h.account))
  const perDay = DAY_MS / i.params.houseEveryMs
  let dayNeed = 0
  let floor = Infinity
  for (const b of belts) {
    const toll = Number(b.toll) / NEAR
    const fee = Number(b.forge_fee) / NEAR
    const back = b.holder && npcs.has(b.holder) ? HOLDER_SHARE * Math.max(0, toll - fee - BOUT_STORAGE_NEAR) : 0
    dayNeed += perDay * (toll - back)
    floor = Math.min(floor, toll + fee)
  }
  const known = i.house.filter((h) => h.balance !== null)
  if (!belts.length) return check('house', known.length ? near(known.reduce((a, h) => a + h.balance!, 0n)) : null, 0, 0, 'NEAR')
  if (!known.length) return check('house', null, floor, dayNeed, 'NEAR')
  const total = near(known.reduce((a, h) => a + h.balance!, 0n))!
  const richest = Math.max(...known.map((h) => near(h.balance)!))
  const c = check('house', total, floor, dayNeed, 'NEAR')
  return richest < floor ? { ...c, level: 'out' } : c
}

/** Demo sponsor: refuses a new judge demo account below its floor (guest.ts SPONSOR_DRY); a day is ~10 accounts + bell gas. */
export function sponsorCheck(i: HealthInput): HealthCheck {
  const per = Number(i.params.demoAccountYocto) / NEAR
  return check('sponsor', near(i.sponsorYocto), i.params.sponsorFloorNear, i.params.sponsorFloorNear + DEMO_ACCOUNTS_PER_DAY * per + SPONSOR_BELL_GAS_NEAR_PER_DAY, 'NEAR')
}

const roundsPerDay = (i: HealthInput) => 86_400 / i.params.seasonSec

/** Vance's NEAR: one open_season per belt per round (forge fee + gas); below fee + 0.03 NEAR it cannot open one. */
export function promoterNearCheck(i: HealthInput): HealthCheck {
  const fee = i.belts.length ? Math.max(...i.belts.map((b) => Number(b.forge_fee) / NEAR)) : 0
  return check('promoter_near', near(i.vanceYocto), fee + OPEN_FLOOR_GAS_NEAR, i.belts.length * roundsPerDay(i) * (fee + OPEN_GAS_NEAR), 'NEAR')
}

/** Vance's Base Sepolia ETH: one purse per belt per round (purse + L1 fee reserve + gas); below the smallest purse it pauses. */
export function promoterEthCheck(i: HealthInput): HealthCheck {
  const perPurse = Number(i.params.purseWei + L1_FEE_RESERVE_WEI + PURSE_GAS_WEI) / ETH
  const floor = Number(MIN_PURSE_WEI + L1_FEE_RESERVE_WEI + PURSE_GAS_WEI) / ETH
  return check('promoter_eth', i.vanceWei === null ? null : Number(i.vanceWei) / ETH, floor, i.belts.length * roundsPerDay(i) * perPurse, 'ETH')
}

/** NEAR AI forge: out when the public budget or the contract's compile cap is closed for today; low under 20 compiles. */
export function forgeCheck(i: HealthInput): HealthCheck {
  const f = i.forge
  const c = check('forge', f ? f.publicLeftUsd : null, 0, FORGE_LOW_COMPILES * WORST_COMPILE_USD, 'USD')
  const capsShut = !!i.caps && (i.caps.today >= i.caps.daily || i.caps.used >= i.caps.total)
  const capsLow = !!i.caps && (i.caps.daily - i.caps.today < FORGE_LOW_COMPILES / 4 || i.caps.total - i.caps.used < FORGE_LOW_COMPILES / 4)
  const shut = (f && !f.open && f.reason !== null) || capsShut
  const out: HealthCheck = { ...c, dayNeed: round(i.params.publicDailyUsd) }
  if (shut) return { ...out, level: 'out' }
  if (capsLow && out.level === 'ok') return { ...out, level: 'low' }
  return out
}

export function assessHealth(i: HealthInput): Health {
  return { at: i.now, checks: [promoterEthCheck(i), promoterNearCheck(i), houseCheck(i), sponsorCheck(i), forgeCheck(i)], forgeResetsAt: i.forge?.resetsAt ?? null }
}


/** Tick step: read every balance (failures become `unknown`, never a thrown tick) and store the record. */
export async function healthStep(d: TickDeps, belts: RawBelt[]): Promise<Health | null> {
  const kv = d.env.TS_KV
  const key = tickKey(d, 'health:v1')
  const prev = await getJson<Health>(kv, key)
  if (prev && d.now() - prev.at < HEALTH_EVERY_MS) return null
  const opt = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f() } catch { return null } }
  const ids = { a: d.env.HOUSE_A_ID, b: d.env.HOUSE_B_ID }
  const vanceId = d.env.VANCE_ID ?? DEFAULTS.vanceId
  const cfg = await opt(() => d.chain.config())
  const [house, sponsorYocto, vanceYocto, vanceWei, forge, caps] = await Promise.all([
    Promise.all(HOUSE_NPCS.map(async (n) => {
      const account = ids[n.key] ?? n.id
      const v = await opt(() => d.chain.view<string>('balance_of', { account }))
      return { account, balance: v === null ? null : BigInt(v ?? '0') }
    })),
    opt(() => d.near.balance(d.env.SPONSOR_ID ?? DEFAULTS.sponsorId)),
    opt(() => d.near.balance(vanceId)),
    opt(async () => getBalance(d.base, await deriveEvmAddress(d.near, d.mpc, VANCE_PATH, vanceId))),
    cfg ? opt(async () => (await forgeStatus(d.env, cfg.model_id)).forge) : Promise.resolve(null),
    opt(() => d.chain.compileCaps()),
  ])
  const econ = economicsOf(d.env)
  const h = assessHealth({
    now: d.now(), belts, house, sponsorYocto, vanceYocto, vanceWei, forge, caps,
    params: {
      houseEveryMs: everyMs(d.env), seasonSec: seasonSecOf(d), purseWei: purseWeiOf(d),
      demoAccountYocto: econ.deposit + econ.gas, sponsorFloorNear: econ.floorNear, publicDailyUsd: toUsd(limitsOf(d.env).publicDaily),
    },
  })
  await putJson(kv, key, h, RECORD_SEC)
  return h
}
