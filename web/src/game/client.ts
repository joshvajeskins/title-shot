import type { Account, Belt, Fight, ForgeProgress, Odds, Spec } from './types'

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
}

export class GameError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Sentence rules shared with the contract: 3–120 chars after trimming and collapsing whitespace. */
export function cleanSentence(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
export function sentenceProblem(s: string): string | null {
  const c = cleanSentence(s)
  if (c.length < 3) return 'Give it at least a few words.'
  if (c.length > 120) return 'Keep it under 120 characters.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(c)) return 'No control characters.'
  return null
}
