// Vance opens the next season: opener sentence (NEAR AI), purse funded from Vance's own Chain-Signatures address,
// open_season, then set_purse_address. Every step is re-entrant: a half-finished open is completed on the next tick.
import { TGAS } from '../../src/game/chain/signer'
import type { RawBelt } from '../../src/game/chain/views'
import { getJson, putJson, putJsonStrict } from './cache'
import { deriveEvmAddress, getBalance } from './evm'
import { DEFAULTS } from './env'
import { writeOpener } from './opener'
import { fundPurse, MIN_PURSE_WEI, VANCE_PATH, type FundResult, type SavedFunding } from './purse'
import { detailOf, tickKey, type Log, type TickDeps } from './tickTypes'

const OPEN_GAS_YOCTO = 30_000_000_000_000_000_000_000n // 300 Tgas at the testnet minimum gas price (0.03 NEAR)
const REOPEN_DELAY_MS = 60_000 // lets the UI show the bell before the next season starts
// An Aborted season (its opener sentence was refused) leaves a funded purse behind and the retry funds a brand new one.
// So retries back off (5, 10, 20 min ...) and stop after MAX_ABORTS in a row until the long pause is over; testnet ETH is scarce.
const ABORT_BACKOFF_MS = 5 * 60_000
const MAX_ABORTS = 4
const ABORT_PAUSE_MS = 6 * 3600_000
const abortKey = (d: TickDeps, b: number) => tickKey(d, `aborts:${b}`)
interface AbortRec { seasonId: number; count: number; at: number }

/** Null = go ahead. Otherwise why opening waits (logged). Counts each Aborted season once. */
export async function abortGate(d: TickDeps, belt: RawBelt): Promise<string | null> {
  const s = belt.season
  const kv = d.env.TS_KV
  if (!s || s.state === 'Open') return null
  if (s.state === 'Closed') { if (await getJson(kv, abortKey(d, belt.id))) await putJson(kv, abortKey(d, belt.id), null); return null }
  let rec = await getJson<AbortRec>(kv, abortKey(d, belt.id))
  if (!rec || rec.seasonId !== s.id) {
    rec = { seasonId: s.id, count: (rec?.count ?? 0) + 1, at: d.now() }
    await putJson(kv, abortKey(d, belt.id), rec, 7 * 86_400)
  }
  const wait = rec.count >= MAX_ABORTS ? ABORT_PAUSE_MS : Math.min(ABORT_BACKOFF_MS * 2 ** (rec.count - 1), 3600_000)
  const left = rec.at + wait - d.now()
  return left > 0 ? `OPEN_BACKOFF: season ${s.id} aborted (${rec.count} in a row): next try in ${Math.ceil(left / 60_000)} min` : null
}

export const pursePath = (beltId: number, seasonId: number) => `belt-${beltId}-s${seasonId}`
const fundKey = (d: TickDeps, b: number, s: number) => tickKey(d, `fund:${b}:${s}`)
// The funding record is only a fast path: kept until open_season succeeds (a week at most), never the only guard.
const FUND_RECORD_SEC = 7 * 86_400

/**
 * The chain is the idempotence key: each season has its own purse address (path belt-<id>-s<season>), so a purse that
 * already holds a season's worth of ETH was funded by an earlier tick (one whose KV record expired, or a tick in another
 * location that this one cannot see yet). Declare that balance instead of funding again. Null = fund it.
 */
async function alreadyFunded(d: TickDeps, purseAddr: string, vanceAccount: string): Promise<FundResult | null> {
  const from = await deriveEvmAddress(d.near, d.mpc, VANCE_PATH, vanceAccount)
  if (from.toLowerCase() === purseAddr.toLowerCase()) return null // degenerate config: Vance's own balance is not a funded purse
  const held = await purseBalance(d, purseAddr)
  return held >= MIN_PURSE_WEI ? { ok: true, address: from, balanceWei: '0', purseWei: held.toString(), detail: 'already funded' } : null
}

/** Pending balance where the node supports it (a funding tx still in the mempool counts), else the latest one. */
async function purseBalance(d: TickDeps, addr: string): Promise<bigint> {
  try { return BigInt(await d.base.call<string>('eth_getBalance', [addr, 'pending'])) } catch { return getBalance(d.base, addr) }
}

export function purseWeiOf(d: TickDeps): bigint {
  try { return d.env.PURSE_WEI ? BigInt(d.env.PURSE_WEI) : DEFAULTS.purseWei } catch { return DEFAULTS.purseWei }
}
export function seasonSecOf(d: TickDeps): number {
  const n = Number(d.env.SEASON_SEC)
  return Number.isInteger(n) && n >= 60 ? n : DEFAULTS.seasonSec
}

export async function derivePurse(d: TickDeps, beltId: number, seasonId: number): Promise<string> {
  return deriveEvmAddress(d.near, d.mpc, pursePath(beltId, seasonId), d.chain.id)
}

/** A season exists but its purse address was never recorded: derive it and set it (promoter call). */
export async function fixPurseAddress(d: TickDeps, log: Log, belt: RawBelt): Promise<void> {
  const s = belt.season
  if (!s || s.purse.address || s.purse.next_nonce !== 0 || !d.vance || belt.promoter !== d.vance.accountId) return
  const addr = await derivePurse(d, belt.id, s.id)
  const out = await d.vance.call(d.chain.id, 'set_purse_address', { belt: belt.id, season: s.id, addr }, 30n * TGAS, 1n)
  log({ belt: belt.id, action: 'set_purse_address', ok: !out.failure, detail: detailOf(out) ?? addr, tx: out.hash })
}

/** True when this belt needs a new season now. */
export function needsOpening(belt: RawBelt, nowMs: number): boolean {
  const s = belt.season
  if (!s) return true
  if (s.state === 'Aborted') return true
  if (s.state !== 'Closed') return false
  return nowMs >= Number(BigInt(s.closes_at) / 1_000_000n) + REOPEN_DELAY_MS
}

export async function openStep(d: TickDeps, log: Log, belt: RawBelt): Promise<void> {
  const vance = d.vance
  if (!vance || belt.promoter !== vance.accountId) return
  const kv = d.env.TS_KV
  const hold = await abortGate(d, belt)
  if (hold) { log({ belt: belt.id, action: 'open_backoff', ok: false, detail: hold }); return }
  // 0. a contract that refuses every challenge (E_NOT_READY) must not get funded seasons nobody can play
  const gates = await d.chain.deployGates().catch(() => null) // unreadable gates (older contract, RPC blip) do not block
  if (gates && gates.ready === false) {
    log({ belt: belt.id, action: 'open', ok: false, detail: `NOT_READY: ${gates.failing.filter((g) => g.blocking).map((g) => g.gate).join(', ') || 'deploy gates unmet'}` })
    return
  }
  const seasonId = (belt.season?.id ?? 0) + 1
  const cfg = await d.chain.config()
  // 1. the opener sentence (kept in KV so a retried tick reuses it)
  const sentenceKey = tickKey(d, `opener:${belt.id}:${seasonId}`)
  let opener = await getJson<{ sentence: string; source: string }>(kv, sentenceKey)
  if (!opener) {
    const recent = (await getJson<string[]>(kv, tickKey(d, 'openers:recent'))) ?? []
    opener = await writeOpener(d.env, cfg.model_id, { seasonId, recent }, d.fetchFn)
    await putJson(kv, sentenceKey, opener, 3600)
    await putJson(kv, tickKey(d, 'openers:recent'), [...recent, opener.sentence].slice(-20))
  }
  // 2. fund the purse (purse address derived from the contract's own path), at most once per season; never when Vance
  //    cannot pay open_season afterwards (forge fee + 300 Tgas), since a funded purse with no season is ETH parked for nothing
  const fee = BigInt(belt.forge_fee)
  const nearBal = await d.near.balance(vance.accountId).catch(() => null)
  if (nearBal !== null && nearBal < fee + OPEN_GAS_YOCTO) { log({ belt: belt.id, action: 'open', ok: false, detail: `VANCE_NEAR_DRY: ${vance.accountId} needs forge fee + gas in NEAR` }); return }
  const purseAddr = await derivePurse(d, belt.id, seasonId)
  const key = fundKey(d, belt.id, seasonId)
  const saved = await getJson<SavedFunding>(kv, key)
  const fund = (!saved && (await alreadyFunded(d, purseAddr, vance.accountId)))
    || (await fundPurse({ near: d.near, base: d.base, vance, mpc: d.mpc }, purseAddr, purseWeiOf(d), saved, (s) => putJsonStrict(kv, key, s, FUND_RECORD_SEC)))
  log({ belt: belt.id, action: 'fund_purse', ok: fund.ok, detail: fund.ok ? `${fund.purseWei} wei to ${purseAddr}${fund.detail ? ` (${fund.detail})` : ''}` : `${fund.code}${fund.detail ? ': ' + fund.detail : ''}`, tx: fund.txHash })
  if (!fund.ok || !fund.purseWei) return
  // 3. open the season with the declared purse (attach the forge fee; the contract refunds the excess)
  const open = await vance.call(d.chain.id, 'open_season', { belt_id: belt.id, opener_sentence: opener.sentence, duration_sec: seasonSecOf(d), purse_wei: fund.purseWei }, 300n * TGAS, fee, 120_000)
  log({ belt: belt.id, action: 'open_season', ok: !open.failure, detail: detailOf(open) ?? `"${opener.sentence}" (${opener.source})`, tx: open.hash })
  if (open.failure) return
  // 4. record the purse address for the new season
  const set = await vance.call(d.chain.id, 'set_purse_address', { belt: belt.id, season: seasonId, addr: purseAddr }, 30n * TGAS, 1n)
  log({ belt: belt.id, action: 'set_purse_address', ok: !set.failure, detail: detailOf(set), tx: set.hash })
  await putJson(kv, key, null, 60)
}
