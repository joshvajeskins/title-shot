// "My corner": one account's bouts, fighters, belts and earnings, derived from the contract's own views. Pure functions, so
// every figure the page shows can be tested against hand-built fights. Amounts stay bigint (yoctoNEAR / wei) until display.
import { keccak_256 } from '@noble/hashes/sha3.js'
import { fromHex, toHex } from '../chain/bytes'
import { nsToMs, type RawFight, type RawPayout, type RawSeason } from '../chain/views'

export type Role = 'challenger' | 'holder'
/** From the account's side: took the belt, lost a title shot, drew, defended the belt, or lost it. */
export type Outcome = 'took' | 'lost' | 'draw' | 'defended' | 'dethroned'

export interface BoutRow {
  id: number; beltId: number; seasonId: number; at: number; role: Role; outcome: Outcome
  /** the account's own fighter in this bout, and the one across the ring */
  myHash: string; oppHash: string; opponent: string
  /** what the challenger paid: the bout's split + storage + the belt's forge fee (they add up to the toll exactly) */
  tollYocto: bigint
  /** what this account received from the bout: the champion's share when it held the belt, else 0 */
  receivedYocto: bigint
}

export interface FighterRecord { w: number; l: number; d: number; defences: number; bouts: number }

export interface Earnings {
  /** sum of split.champion over bouts where the account held the belt (credited to its balance by the contract) */
  championYocto: bigint; championBouts: number
  /** season side-pots credited at the bell to the account as final holder */
  sidePotYocto: bigint; sidePotSeasons: number
  /** tolls the account paid as a challenger */
  tollsPaidYocto: bigint; challenges: number
}

export type PayoutState = 'claimable' | 'signing' | 'unsigned' | 'signed' | 'mined' | 'reverted'
export interface MyPayout { id: number; beltId: number; seasonId: number; amountWei: bigint; to: string | null; state: PayoutState; txHash: string | null; share: 'holder' | 'defences' }

const outcomeOf = (role: Role, winner: 0 | 1 | 2): Outcome =>
  role === 'challenger' ? (winner === 1 ? 'took' : winner === 2 ? 'draw' : 'lost') : (winner === 1 ? 'dethroned' : winner === 2 ? 'draw' : 'defended')

const splitTotal = (f: RawFight): bigint =>
  BigInt(f.split.champion) + BigInt(f.split.promoter) + BigInt(f.split.side_pot) + BigInt(f.split.protocol) + BigInt(f.storage ?? '0')

/** The account's bouts, newest first. `forgeFee` is each belt's forge fee (the fight view does not carry it). */
export function boutsOf(fights: RawFight[], me: string, forgeFee: Map<number, bigint>): BoutRow[] {
  const rows: BoutRow[] = []
  const seen = new Set<number>()
  for (const f of fights) {
    if (seen.has(f.id) || (f.challenger !== me && f.holder !== me)) continue
    seen.add(f.id)
    const role: Role = f.challenger === me ? 'challenger' : 'holder'
    rows.push({
      id: f.id, beltId: f.belt_id, seasonId: f.season_id, at: nsToMs(f.at), role, outcome: outcomeOf(role, f.winner_code),
      myHash: role === 'challenger' ? f.challenger_hash : f.champion_hash,
      oppHash: role === 'challenger' ? f.champion_hash : f.challenger_hash,
      opponent: role === 'challenger' ? f.holder : f.challenger,
      tollYocto: splitTotal(f) + (forgeFee.get(f.belt_id) ?? 0n),
      receivedYocto: role === 'holder' ? BigInt(f.split.champion) : 0n,
    })
  }
  return rows.sort((a, b) => b.id - a.id)
}

/** Per fighter (sentence hash): wins, losses, draws and title defences in this account's bouts only. A held draw is a defence. */
export function recordsOf(bouts: BoutRow[]): Map<string, FighterRecord> {
  const out = new Map<string, FighterRecord>()
  for (const b of bouts) {
    const r = out.get(b.myHash) ?? { w: 0, l: 0, d: 0, defences: 0, bouts: 0 }
    r.bouts += 1
    if (b.outcome === 'took' || b.outcome === 'defended') r.w += 1
    else if (b.outcome === 'draw') r.d += 1
    else r.l += 1
    if (b.role === 'holder' && b.outcome !== 'dethroned') r.defences += 1
    out.set(b.myHash, r)
  }
  return out
}

/** The account's fighters, most recently fought first. */
export function fighterOrder(bouts: BoutRow[]): string[] {
  return [...new Set(bouts.map((b) => b.myHash))]
}

/** Overall record across every fighter. */
export function totalRecord(records: Map<string, FighterRecord>): FighterRecord {
  const t = { w: 0, l: 0, d: 0, defences: 0, bouts: 0 }
  for (const r of records.values()) { t.w += r.w; t.l += r.l; t.d += r.d; t.defences += r.defences; t.bouts += r.bouts }
  return t
}

export interface SeasonRead { beltId: number; season: RawSeason }

/** Seasons whose bell could have paid this account: every season it fought in, plus the current season of each belt it holds. */
export function seasonsToRead(bouts: BoutRow[], held: { beltId: number; seasonId: number }[]): [number, number][] {
  const keys = new Set<string>()
  for (const b of bouts) keys.add(`${b.beltId}:${b.seasonId}`)
  for (const h of held) if (h.seasonId > 0) keys.add(`${h.beltId}:${h.seasonId}`)
  return [...keys].map((k) => k.split(':').map(Number) as [number, number])
}

/** A closed season can owe this account a payout only if it was the final holder or defended in it. */
export const seasonPays = (s: RawSeason, me: string): boolean =>
  s.state === 'Closed' && s.payouts.length > 0 && (s.final_holder === me || s.defence_count.some((d) => d.account === me))

export function earningsOf(bouts: BoutRow[], seasons: SeasonRead[], me: string): Earnings {
  const e: Earnings = { championYocto: 0n, championBouts: 0, sidePotYocto: 0n, sidePotSeasons: 0, tollsPaidYocto: 0n, challenges: 0 }
  for (const b of bouts) {
    if (b.role === 'holder') { e.championYocto += b.receivedYocto; e.championBouts += 1 }
    else { e.tollsPaidYocto += b.tollYocto; e.challenges += 1 }
  }
  const seen = new Set<string>()
  for (const { beltId, season } of seasons) {
    const k = `${beltId}:${season.id}`
    if (seen.has(k) || season.state !== 'Closed' || season.final_holder !== me) continue
    seen.add(k)
    const pot = BigInt(season.side_pot)
    if (pot > 0n) { e.sidePotYocto += pot; e.sidePotSeasons += 1 }
  }
  return e
}

/** NEAR received in total (champion's share + side-pots). Tolls paid are shown beside it, not netted silently. */
export const nearEarned = (e: Earnings): bigint => e.championYocto + e.sidePotYocto

/** The Base tx hash of a signed payout: keccak256 of the signed raw transaction bytes. */
export function payoutTxHash(rawTx: string | null): string | null {
  if (!rawTx) return null
  try { return '0x' + toHex(keccak_256(fromHex(rawTx))) } catch { return null }
}

/** Receipt status from Base: '0x1' mined, '0x0' reverted, no receipt yet = still signed (broadcast or waiting). */
export type ReceiptStatus = 'mined' | 'reverted' | null

/** This account's purse shares on Base, newest first. `receipts` maps a tx hash to what Base says about it. */
export function myPayouts(payouts: RawPayout[], seasons: SeasonRead[], me: string, receipts: Map<string, ReceiptStatus>): MyPayout[] {
  const finalOf = new Map(seasons.map((s) => [`${s.beltId}:${s.season.id}`, s.season.final_holder]))
  const seen = new Set<number>()
  const out: MyPayout[] = []
  for (const p of payouts) {
    if (p.payee !== me || seen.has(p.id)) continue
    seen.add(p.id)
    const txHash = payoutTxHash(p.raw_tx)
    const r = txHash ? receipts.get(txHash) ?? null : null
    const state: PayoutState = !p.to ? 'claimable' : txHash ? (r ?? 'signed') : p.signing ? 'signing' : 'unsigned'
    out.push({
      id: p.id, beltId: p.belt_id, seasonId: p.season_id, amountWei: BigInt(p.amount_wei), to: p.to, state, txHash,
      share: finalOf.get(`${p.belt_id}:${p.season_id}`) === me ? 'holder' : 'defences',
    })
  }
  return out.sort((a, b) => b.id - a.id)
}

/** Belt ids from nft_tokens_for_owner (token ids are `belt-<id>`). */
export function heldBeltIds(tokens: { token_id: string; owner_id?: string }[], me: string): number[] {
  return tokens.filter((t) => !t.owner_id || t.owner_id === me).map((t) => /^belt-(\d+)$/.exec(t.token_id)?.[1]).filter((x): x is string => !!x).map(Number)
}
