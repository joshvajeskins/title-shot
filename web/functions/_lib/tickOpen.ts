// Vance opens the next season: opener sentence (NEAR AI), purse funded from Vance's own Chain-Signatures address,
// open_season, then set_purse_address. Every step is re-entrant: a half-finished open is completed on the next tick.
import { TGAS } from '../../src/game/chain/signer'
import type { RawBelt } from '../../src/game/chain/views'
import { getJson, putJson, putJsonStrict } from './cache'
import { deriveEvmAddress } from './evm'
import { DEFAULTS } from './env'
import { writeOpener } from './opener'
import { fundPurse, type SavedFunding } from './purse'
import { detailOf, type Log, type TickDeps } from './tickTypes'

const REOPEN_DELAY_MS = 60_000 // lets the UI show the bell before the next season starts
// An Aborted season (its opener sentence was refused) leaves a funded purse behind and the retry funds a brand new one.
// So retries back off (5, 10, 20 min ...) and stop after MAX_ABORTS in a row until the long pause is over; testnet ETH is scarce.
const ABORT_BACKOFF_MS = 5 * 60_000
const MAX_ABORTS = 4
const ABORT_PAUSE_MS = 6 * 3600_000
const abortKey = (b: number) => `aborts:${b}`
interface AbortRec { seasonId: number; count: number; at: number }

/** Null = go ahead. Otherwise why opening waits (logged). Counts each Aborted season once. */
export async function abortGate(d: TickDeps, belt: RawBelt): Promise<string | null> {
  const s = belt.season
  const kv = d.env.TS_KV
  if (!s || s.state === 'Open') return null
  if (s.state === 'Closed') { if (await getJson(kv, abortKey(belt.id))) await putJson(kv, abortKey(belt.id), null); return null }
  let rec = await getJson<AbortRec>(kv, abortKey(belt.id))
  if (!rec || rec.seasonId !== s.id) {
    rec = { seasonId: s.id, count: (rec?.count ?? 0) + 1, at: d.now() }
    await putJson(kv, abortKey(belt.id), rec, 7 * 86_400)
  }
  const wait = rec.count >= MAX_ABORTS ? ABORT_PAUSE_MS : Math.min(ABORT_BACKOFF_MS * 2 ** (rec.count - 1), 3600_000)
  const left = rec.at + wait - d.now()
  return left > 0 ? `OPEN_BACKOFF: season ${s.id} aborted (${rec.count} in a row): next try in ${Math.ceil(left / 60_000)} min` : null
}

export const pursePath = (beltId: number, seasonId: number) => `belt-${beltId}-s${seasonId}`
const fundKey = (b: number, s: number) => `fund:${b}:${s}`

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
  const seasonId = (belt.season?.id ?? 0) + 1
  const cfg = await d.chain.config()
  // 1. the opener sentence (kept in KV so a retried tick reuses it)
  const sentenceKey = `opener:${belt.id}:${seasonId}`
  let opener = await getJson<{ sentence: string; source: string }>(kv, sentenceKey)
  if (!opener) {
    const recent = (await getJson<string[]>(kv, 'openers:recent')) ?? []
    opener = await writeOpener(d.env, cfg.model_id, { seasonId, recent }, d.fetchFn)
    await putJson(kv, sentenceKey, opener, 3600)
    await putJson(kv, 'openers:recent', [...recent, opener.sentence].slice(-20))
  }
  // 2. fund the purse (purse address derived from the contract's own path)
  const purseAddr = await derivePurse(d, belt.id, seasonId)
  const saved = await getJson<SavedFunding>(kv, fundKey(belt.id, seasonId))
  const fund = await fundPurse({ near: d.near, base: d.base, vance, mpc: d.mpc }, purseAddr, purseWeiOf(d), saved, (s) => putJsonStrict(kv, fundKey(belt.id, seasonId), s, 3600))
  log({ belt: belt.id, action: 'fund_purse', ok: fund.ok, detail: fund.ok ? `${fund.purseWei} wei to ${purseAddr}` : `${fund.code}${fund.detail ? ': ' + fund.detail : ''}`, tx: fund.txHash })
  if (!fund.ok || !fund.purseWei) return
  // 3. open the season with the declared purse (attach the forge fee; the contract refunds the excess)
  const fee = BigInt(belt.forge_fee)
  const open = await vance.call(d.chain.id, 'open_season', { belt_id: belt.id, opener_sentence: opener.sentence, duration_sec: seasonSecOf(d), purse_wei: fund.purseWei }, 300n * TGAS, fee, 120_000)
  log({ belt: belt.id, action: 'open_season', ok: !open.failure, detail: detailOf(open) ?? `"${opener.sentence}" (${opener.source})`, tx: open.hash })
  if (open.failure) return
  // 4. record the purse address for the new season
  const set = await vance.call(d.chain.id, 'set_purse_address', { belt: belt.id, season: seasonId, addr: purseAddr }, 30n * TGAS, 1n)
  log({ belt: belt.id, action: 'set_purse_address', ok: !set.failure, detail: detailOf(set), tx: set.hash })
  await putJson(kv, fundKey(belt.id, seasonId), null, 60)
}
