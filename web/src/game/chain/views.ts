// Contract JSON views -> the UI's domain types. One place that knows both shapes. Pure functions.
import { sha256 } from '@noble/hashes/sha2.js'
import roster from '../roster.json'
import { toHex, utf8 } from './bytes'
import { BASESCAN, NS_PER_MS } from './config'
import { cleanSentence, type FightSummary } from '../client'
import type { Belt, Fight, Fighter, Rule, Season, TollSplit } from '../types'
import { toUiSpec, type ChainSpec, type Rulebook } from '../../sim'

export interface RawFighter {
  hash: string; sentence: string; spec: ChainSpec; writer: string; forged_at: string; signer: string
  record: { wins: number; losses: number; draws: number }
}
export interface RawSeason {
  id: number; state: 'Opening' | 'Open' | 'Closed' | 'Aborted'; duration_sec: number; opens_at: string; closes_at: string
  rule: number | null; sealed: boolean; side_pot: string; bouts: number; challenges: number; pending: number
  purse: { chain_id: number; path: string; amount_wei: string; address: string | null; next_nonce: number }
  defence_count: { account: string; defences: number }[]; payouts: number[]; final_holder: string | null
}
export interface RawBelt {
  id: number; name: string; token_id: string; promoter: string; holder: string | null; toll: string; forge_fee: string
  purse_chain_id: number; media: string; season: RawSeason | null; champion: RawFighter | null; reign_since: string
  defences: number; fights: number; top_defenders: { account: string; defences: number }[]
}
export interface RawFight {
  id: number; challenge_id: number; belt_id: number; season_id: number; champion_hash: string; challenger_hash: string
  holder: string; challenger: string; seed: string; seed_source: string; rule: number; winner: string; winner_code: 0 | 1 | 2
  state_hash: string; split: { champion: string; promoter: string; side_pot: string; protocol: string }; at: string
}
export interface RawChallenge {
  id: number; belt_id: number; season_id: number; challenger: string; sentence: string; hash: string
  status: 'Forging' | 'Resolved' | 'Rejected' | 'Refunded'; code: string | null; detail: string | null; fight_id: number | null
  created_at: string; need_compile: boolean; kind: 'Challenge' | 'Opener'; toll: string; fee: string; relayer: boolean
}
export interface RawPayout {
  id: number; belt_id: number; season_id: number; payee: string; amount_wei: string; to: string | null; nonce: number | null
  signing: boolean; raw_tx: string | null; attempt: number; value_wei: string | null; max_fee_per_gas: string | null; gas_limit: number | null
}

export const nsToMs = (ns: string | number | bigint): number => Number(BigInt(ns) / NS_PER_MS)

/** sha256 of the cleaned sentence, hex: the contract's fighter key. */
export function sentenceHash(sentence: string): string {
  return toHex(sha256(utf8(cleanSentence(sentence))))
}

type RosterRow = { sentence: string; portrait: string }
const CURATED = new Map((roster as RosterRow[]).map((r) => [cleanSentence(r.sentence).toLowerCase(), r.portrait]))

/** Curated art for the seeded sentences, else the generated portrait endpoint. */
export function portraitFor(sentence: string, hash: string): string {
  return CURATED.get(cleanSentence(sentence).toLowerCase()) ?? `/api/portrait/${hash}`
}

export function mapFighter(raw: RawFighter): Fighter {
  return {
    sentence: raw.sentence, sentenceHash: raw.hash, spec: toUiSpec(raw.spec), portrait: portraitFor(raw.sentence, raw.hash),
    writer: raw.writer, record: { w: raw.record.wins, l: raw.record.losses, d: raw.record.draws },
  }
}

export function ruleOf(id: number | null | undefined, rb: Rulebook): Rule | null {
  if (id === null || id === undefined) return null
  const r = rb.rules.find((x) => x.id === id)
  return r ? { id: r.id, name: r.name, desc: r.desc } : { id, name: `Rule ${id}`, desc: '' }
}

const BELT_STYLES: { re: RegExp; art: string; accent: Belt['accent'] }[] = [
  { re: /midnight/i, art: '/art/belt-midnight.webp', accent: 'gold' },
  { re: /tide|water|sea/i, art: '/art/belt-tide.webp', accent: 'blue' },
  { re: /wild/i, art: '/art/belt-wildcard.webp', accent: 'red' },
]

export function beltStyle(name: string, id: number): { art: string; accent: Belt['accent'] } {
  const hit = BELT_STYLES.find((s) => s.re.test(name)) ?? BELT_STYLES[(Math.max(id, 1) - 1) % BELT_STYLES.length]!
  return { art: hit.art, accent: hit.accent }
}

export function mapSeason(s: RawSeason | null, rb: Rulebook): Season {
  if (!s) {
    return { id: 0, startsAt: 0, endsAt: 0, rule: null, purse: { chain: 'base-sepolia', address: '', amountWei: '0', symbol: 'ETH', explorer: BASESCAN }, sidePotYocto: '0', challenges: 0 }
  }
  const addr = s.purse.address ?? ''
  return {
    id: s.id, startsAt: nsToMs(s.opens_at), endsAt: nsToMs(s.closes_at), rule: s.sealed ? null : ruleOf(s.rule, rb),
    purse: { chain: 'base-sepolia', address: addr, amountWei: s.purse.amount_wei, symbol: 'ETH', explorer: addr ? `${BASESCAN}/address/${addr}` : BASESCAN },
    sidePotYocto: s.side_pot, challenges: s.challenges,
  }
}

/** Champion share of one toll (60% of toll minus forge fee), the contract's `split_toll`. */
export const championShare = (toll: bigint, fee: bigint): bigint => ((toll - fee) * 60n) / 100n

export type ChainBelt = Belt & { numericId: number; seasonState: RawSeason['state'] | 'None'; holder: string | null; promoter: string; forgeFeeYocto: string }

/** Null when the belt has no champion yet (no opener forged): there is nothing to show. */
export function mapBelt(raw: RawBelt, rb: Rulebook): ChainBelt | null {
  if (!raw.champion) return null
  const st = beltStyle(raw.name, raw.id)
  const champion = mapFighter(raw.champion)
  const earned = raw.holder === raw.champion.writer ? championShare(BigInt(raw.toll), BigInt(raw.forge_fee)) * BigInt(raw.defences) : 0n
  return {
    id: String(raw.id), numericId: raw.id, name: raw.name, art: st.art, accent: st.accent, champion,
    reignSince: nsToMs(raw.reign_since), defences: raw.defences, failedChallengers: raw.defences,
    writerEarnedYocto: earned.toString(), tollYocto: raw.toll, season: mapSeason(raw.season, rb),
    seasonState: raw.season?.state ?? 'None', holder: raw.holder, promoter: raw.promoter, forgeFeeYocto: raw.forge_fee,
  }
}

export function mapSplit(raw: RawFight['split'], forgeFee: string): TollSplit {
  return { champion: raw.champion, promoter: raw.promoter, sidePot: raw.side_pot, protocol: raw.protocol, forgeFee }
}

export function mapFightSummary(f: RawFight, names: { champion: string; challenger: string }, toll: string): FightSummary {
  return {
    id: String(f.id), beltId: String(f.belt_id), challenger: f.challenger, challengerName: names.challenger,
    champion: f.holder, championName: names.champion, winner: f.winner_code, at: nsToMs(f.at), tollYocto: toll,
  }
}

export function assembleFight(raw: RawFight, champion: Fighter, challenger: Fighter, rule: Rule, events: Fight['events'], split: TollSplit, receipts: Fight['receipts']): Fight {
  return {
    id: String(raw.id), beltId: String(raw.belt_id), champion, challenger, seed: raw.seed, rule, events, winner: raw.winner_code,
    stateHash: raw.state_hash, split, receipts, at: nsToMs(raw.at),
  }
}
