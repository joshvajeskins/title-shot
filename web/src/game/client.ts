import type { Account, Belt, Fight, ForgeProgress, Odds, Spec } from './types'
import { cleanSentence as cleanSentenceImpl, sentenceProblem as sentenceProblemImpl } from './sentence'

export interface PreviewResult {
  spec: Spec
  portrait: string | null
  /** true when this sentence was already forged on chain: the spec is final */
  canonical: boolean
  /** NEAR AI signature evidence for the preview compile, when available */
  signer?: string
}

export interface FightSummary {
  id: string
  beltId: string
  challenger: string
  challengerName: string
  champion: string
  championName: string
  winner: 0 | 1 | 2
  at: number
  tollYocto: string
}

export interface GameClient {
  readonly mode: 'mock' | 'testnet'
  account(): Promise<Account | null>
  createGuest(): Promise<Account>
  signOut(): Promise<void>
  belts(): Promise<Belt[]>
  belt(id: string): Promise<Belt>
  preview(sentence: string): Promise<PreviewResult>
  odds(champion: Spec, challenger: Spec, rule: number, n?: number): Odds
  challenge(beltId: string, sentence: string, onProgress: (p: ForgeProgress) => void): Promise<Fight>
  fight(id: string): Promise<Fight>
  history(beltId?: string): Promise<FightSummary[]>
  /** The Base address registered for purse payouts (lowercase), or null. Optional: absent on clients without a chain. */
  payoutAddress?(): Promise<string | null>
  /** Register the Base address for purse payouts (0x + 40 hex, any casing). Throws GameError E_ADDRESS on a bad address. */
  setPayoutAddress?(addr: string): Promise<void>
  /** Name the Base address for a purse payout created while the payee had none (claim_payout). Returns the tx hash. */
  claimPayout?(payoutId: number, addr: string): Promise<string>
  /** Withdraw the whole game balance to the account (a wallet account approves it in its wallet). Returns the tx hash. */
  withdraw?(): Promise<string>
}

export class GameError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Sentence rules shared with the contract and the Rust crate: see ./sentence.ts (code-point length, no control/invisible/bidi characters). */
export function cleanSentence(s: string): string {
  return cleanSentenceImpl(s)
}
export function sentenceProblem(s: string): string | null {
  return sentenceProblemImpl(s)
}
