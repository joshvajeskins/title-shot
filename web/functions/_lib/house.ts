// House challengers (docs/LIVENESS.md): when a belt has an open season, nothing pending and no bout for HOUSE_EVERY_MIN
// minutes, one house NPC challenges it with a fresh NEAR AI sentence, paying the toll from its own game balance through a
// function-call key that can only call `challenge`. At most one house challenge per tick. Idempotent: the belt's KV marker
// is written before the call (a crashed tick never retries early) and the contract allows one pending challenge per account.
import { TGAS, type Signer } from '../../src/game/chain/signer'
import type { RawBelt, RawFight, RawFighter } from '../../src/game/chain/views'
import { getJson, putJson } from './cache'
import type { CompileCaps } from './chain'
import { signerFrom } from './deps'
import { HOUSE_NPCS, writeHouseSentence, type HouseNpc } from './houseNpcs'
import { detailOf, tickKey, type Log, type TickDeps } from './tickTypes'

export { HOUSE_NPCS, HOUSE_PERSONAS } from './houseNpcs'
export const DEFAULT_EVERY_MIN = 25
export const DEFAULT_COMPILES_PER_DAY = 12
/** No house challenge this close to the bell (close_season waits for pending bouts). */
export const CLOSE_MARGIN_MS = 5 * 60_000
const MARK_SEC = 7 * 86_400
const RECENT_MAX = 30
export const HOUSE_GAS_TGAS_RELAYER = 50n
const MAX_CACHED_LOOKUPS = 10 // RPC views per tick when looking for an already forged house fighter

export interface HouseSeat { npc: HouseNpc; signer: Signer }
/** Tests (and a future deps builder) may hand the seats in; otherwise they come from the HOUSE_*_KEY secrets. */
export type HouseDeps = TickDeps & { house?: HouseSeat[] }
type Source = 'nearai' | 'fallback' | 'cached'

const nsMs = (ns: string | number): number => Number(BigInt(ns) / 1_000_000n)
const lower = (s: string) => s.toLowerCase()
export const markKey = (d: TickDeps, beltId: number) => tickKey(d, `house:last:${beltId}`)
export const recentKey = (d: TickDeps) => tickKey(d, 'house:recent')

export function everyMs(env: TickDeps['env']): number {
  const n = Number(env.HOUSE_EVERY_MIN)
  return (Number.isFinite(n) && n >= 1 ? n : DEFAULT_EVERY_MIN) * 60_000
}

export function houseSeats(d: HouseDeps): HouseSeat[] {
  if (d.house) return d.house
  const ids = { a: d.env.HOUSE_A_ID, b: d.env.HOUSE_B_ID }
  const keys = { a: d.env.HOUSE_A_KEY, b: d.env.HOUSE_B_KEY }
  return HOUSE_NPCS.flatMap((npc) => {
    const signer = signerFrom(ids[npc.key] ?? npc.id, keys[npc.key], d.near)
    return signer ? [{ npc, signer }] : []
  })
}

/**
 * The house leaves the second half of the contract's daily compile cap and the last quarter of its total cap to players:
 * past that, it only fields fighters that are already forged (no compile, no NEAR AI). Unreadable caps do not block.
 */
export const capsLeaveRoom = (c: CompileCaps | null): boolean =>
  !c || (c.daily - c.today > c.daily / 2 && c.total - c.used > c.total / 4)

/** New compiles the house may cause per UTC day (each is charged to the public share by the forge charge step). */
export function compilesPerDay(env: TickDeps['env']): number {
  const n = Number(env.HOUSE_COMPILES_PER_DAY)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_COMPILES_PER_DAY
}
export const compilesKey = (d: TickDeps) => tickKey(d, `house:compiles:${new Date(d.now()).toISOString().slice(0, 10)}`)

/** The latest of: season opened, last house challenge here, last bout on this belt (the RPC read only when still due). */
async function lastActivity(d: TickDeps, belt: RawBelt, every: number): Promise<number> {
  let t = nsMs(belt.season!.opens_at)
  const mark = await getJson<number>(d.env.TS_KV, markKey(d, belt.id))
  if (typeof mark === 'number') t = Math.max(t, mark)
  if (belt.fights > 0 && d.now() - t >= every) {
    const [f] = await d.chain.fights(belt.id, 0, 1).catch(() => [] as RawFight[])
    if (f?.at) t = Math.max(t, nsMs(f.at))
  }
  return t
}

/** Belts a house NPC may challenge now, stalest first. */
async function dueBelts(d: TickDeps, belts: RawBelt[]): Promise<RawBelt[]> {
  const now = d.now()
  const every = everyMs(d.env)
  const due: { b: RawBelt; last: number }[] = []
  for (const b of belts) {
    const s = b.season
    if (!s || s.state !== 'Open' || !b.champion || s.pending > 0) continue
    if (nsMs(s.closes_at) - now < CLOSE_MARGIN_MS) continue
    const last = await lastActivity(d, b, every)
    if (now - last >= every) due.push({ b, last })
  }
  return due.sort((x, y) => x.last - y.last).map((x) => x.b)
}

/** The NPC with the most game balance that is not the holder, has nothing pending and can pay toll + fee. */
async function pickSeat(d: TickDeps, log: Log, seats: HouseSeat[], belt: RawBelt): Promise<HouseSeat | null> {
  const need = BigInt(belt.toll) + BigInt(belt.forge_fee)
  let best: { seat: HouseSeat; bal: bigint } | null = null
  for (const seat of seats) {
    const account = seat.signer.accountId
    if (account === belt.holder) continue
    if (await d.chain.view('get_pending', { account })) continue
    const bal = BigInt((await d.chain.view<string>('balance_of', { account })) ?? '0')
    if (bal < need) { log({ belt: belt.id, action: `house:${seat.npc.key}`, ok: false, detail: `HOUSE_DRY: ${account} has ${bal} yocto, needs toll + fee ${need}` }); continue }
    if (!best || bal > best.bal) best = { seat, bal }
  }
  return best?.seat ?? null
}

/** NEAR AI first; a curated sentence when it fails; only already-forged fighters when no compile may be spent. */
async function chooseSentence(d: TickDeps, seat: HouseSeat, belt: RawBelt, model: string, recent: string[]): Promise<{ sentence: string; source: Source } | null> {
  const champion = (belt.champion as RawFighter).sentence
  const avoid = new Set([champion, ...recent].map(lower))
  const caps = await d.chain.compileCaps().catch(() => null)
  const today = (await getJson<number>(d.env.TS_KV, compilesKey(d))) ?? 0
  let mayCompile = capsLeaveRoom(caps) && today < compilesPerDay(d.env)
  if (mayCompile) {
    const w = await writeHouseSentence(d.env, model, seat.npc, champion, recent, d.fetchFn, { now: d.now })
    if (w.sentence && !avoid.has(lower(w.sentence))) return { sentence: w.sentence, source: 'nearai' }
    if (w.closed) mayCompile = false
  }
  const others = HOUSE_NPCS.filter((n) => n.key !== seat.npc.key).flatMap((n) => n.fallback)
  if (mayCompile) {
    const s = seat.npc.fallback.find((x) => !avoid.has(lower(x)))
    if (s) return { sentence: s, source: 'fallback' }
  }
  // no compile: a fighter the house already forged plays for free (cached sentences are never blocked by the caps)
  const candidates = [...recent].reverse().concat(seat.npc.fallback, others).filter((s) => lower(s) !== lower(champion))
  for (const s of candidates.slice(0, MAX_CACHED_LOOKUPS)) {
    if (await d.chain.fighterBySentence(s).catch(() => null)) return { sentence: s, source: 'cached' }
  }
  return null
}

export async function houseStep(d: HouseDeps, log: Log, belts: RawBelt[]): Promise<void> {
  const seats = houseSeats(d)
  if (!seats.length) return
  const kv = d.env.TS_KV
  for (const belt of await dueBelts(d, belts)) {
    const seat = await pickSeat(d, log, seats, belt)
    if (!seat) continue
    const cfg = await d.chain.config()
    const recent = (await getJson<string[]>(kv, recentKey(d))) ?? []
    const pick = await chooseSentence(d, seat, belt, cfg.model_id, recent)
    await putJson(kv, markKey(d, belt.id), d.now(), MARK_SEC) // the marker first: whatever happens next, no retry before the cadence
    if (!pick) { log({ belt: belt.id, action: `house:${seat.npc.key}`, ok: false, detail: 'HOUSE_FORGE_CLOSED: no compile budget and no forged house fighter' }); return }
    // Testnet prepays gas at 10x the gas price (300 Tgas needs 0.301 NEAR of balance AND key allowance, else the tx is
    // silently dropped). challenge() in relayer mode makes no cross-contract call: 50 Tgas (0.051 NEAR prepaid) is plenty.
    const gas = (cfg.forge_mode === 'relayer' ? HOUSE_GAS_TGAS_RELAYER : 300n) * TGAS
    const out = await seat.signer.call(d.chain.id, 'challenge', { belt_id: belt.id, sentence: pick.sentence }, gas, 0n, 60_000)
    log({ belt: belt.id, action: `house_challenge:${seat.npc.key}`, ok: !out.failure, detail: detailOf(out) ?? `${seat.npc.name}: "${pick.sentence}" (${pick.source})`, tx: out.hash })
    if (out.failure) return
    if (!recent.some((s) => lower(s) === lower(pick.sentence))) await putJson(kv, recentKey(d), [...recent, pick.sentence].slice(-RECENT_MAX))
    if (pick.source !== 'cached') await putJson(kv, compilesKey(d), ((await getJson<number>(kv, compilesKey(d))) ?? 0) + 1, 2 * 86_400)
    return // at most one house challenge per tick
  }
}
