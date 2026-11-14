// Domain types. Fight events mirror crates/bout-sim/src/events.rs (serde tag "t", snake_case).

export type School = 'BLAZE' | 'TIDE' | 'VOLT' | 'IRON' | 'MIND' | 'WILD'
export type Style = 'BRAWLER' | 'TACTICIAN' | 'COUNTERPUNCHER' | 'SHOWBOAT'
export type Side = 0 | 1 // 0 champion, 1 challenger

export interface Stats { power: number; guard: number; speed: number; grit: number }
export interface SpecMove { id: string; label: string }
export interface Spec {
  name: string
  title: string
  look: string
  cry: string
  school: School
  style: Style
  moves: SpecMove[]
  stats: Stats
}

export interface Fighter {
  sentence: string
  sentenceHash: string
  spec: Spec
  portrait: string | null
  writer: string
  record: { w: number; l: number; d: number }
}

export interface Rule { id: number; name: string; desc: string }

export interface Purse {
  chain: 'base-sepolia'
  address: string
  amountWei: string
  symbol: 'ETH'
  explorer: string
}

export interface Season {
  id: number
  startsAt: number
  endsAt: number
  rule: Rule | null // null = sealed until the first bout
  purse: Purse
  sidePotYocto: string
  challenges: number
}

export interface PayoutRow {
  payee: string
  name: string
  share: 'holder' | 'defences' | 'refund'
  defences?: number
  /** Base address the payout is signed to (null until the payee registers one). */
  to?: string | null
  amountWei: string
  status: 'unsigned' | 'signed' | 'mined' | 'unclaimed'
  tx?: string
  explorer?: string
}

export interface Bell {
  seasonId: number
  at: number
  holder: string
  holderName: string
  purseWei: string
  sidePotYocto: string
  payouts: PayoutRow[]
}

export interface Belt {
  id: string
  name: string
  art: string
  accent: 'gold' | 'blue' | 'red'
  champion: Fighter
  reignSince: number
  defences: number
  failedChallengers: number
  writerEarnedYocto: string
  tollYocto: string
  season: Season
  lastBell?: Bell | null
}

export type Outcome = 'hit' | 'crit' | 'miss' | 'blocked' | 'countered' | 'used'

export type FightEvent =
  | { t: 'match_start'; rule: number; max_hp: [number, number] }
  | { t: 'round_start'; round: number; form?: [number, number] }
  | { t: 'exchange'; round: number; n: number; first: Side }
  | {
      t: 'act'
      actor: Side
      slot: number
      move_id: number
      outcome: Outcome
      hits: number
      dmg: number
      absorbed: number
      heal: number
      recoil: number
      hp: [number, number]
      shield: [number, number]
      fx_self: number
      fx_foe: number
    }
  | { t: 'skip'; actor: Side }
  | { t: 'upkeep'; side: Side; burn: number; hp: [number, number]; expired: number }
  | { t: 'round_end'; round: number; winner: 0 | 1 | 2; reason: 'ko' | 'limit'; hp: [number, number] }
  | { t: 'match_end'; winner: 0 | 1 | 2; rounds: [number, number] }

export const FX = { BURN: 1, STUN: 2, SHIELD: 4, WEAKEN: 8, HASTE: 16, COUNTER: 32, CHARGE: 64 } as const

export interface Receipt { label: string; tx: string; url: string }

export interface TollSplit {
  champion: string
  promoter: string
  sidePot: string
  protocol: string
  forgeFee: string
}

export interface Fight {
  id: string
  beltId: string
  champion: Fighter
  challenger: Fighter
  seed: string
  rule: Rule
  events: FightEvent[]
  winner: 0 | 1 | 2
  stateHash: string
  split: TollSplit
  receipts: Receipt[]
  at: number
}

export type ForgeStage = 'toll' | 'tee' | 'compile' | 'verify' | 'fight' | 'done'
export interface ForgeProgress {
  stage: ForgeStage
  note?: string
  receipt?: Receipt
}

export interface Account {
  id: string
  kind: 'guest' | 'wallet'
  balanceYocto: string
  claimableYocto: string
}

export interface Odds { win: number; draw: number; loss: number; n: number }
