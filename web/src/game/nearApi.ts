// Calls to the Pages Functions (/api/*). Every failure becomes a GameError a player can read.
import { GameError } from './client'
import type { FightSummary } from './client'
import type { ChainBelt } from './chain/views'

export interface ApiState {
  at: number; contract: string; forgeMode: string; model: string; rulebookHash: string
  belts: ChainBelt[]; fights: FightSummary[]
  payouts: unknown[]; wallets: unknown[]; tick: unknown
}

/** /api/state as the proof page reads it (wallets and payouts typed). */
export interface ApiStateFull extends Omit<ApiState, 'payouts' | 'wallets'> {
  payouts: { id: number; beltId: number; seasonId: number; payee: string; amountWei: string; to: string | null; status: string; txHash?: string; explorer?: string }[]
  wallets: { account: string; role: 'sponsor' | 'promoter' | 'relayer'; nearYocto: string; baseAddress?: string; baseWei?: string }[]
  forge?: { open: boolean; spentUsd?: number; budgetUsd?: number }
}

/** /api/proof (functions/api/proof.ts): contract-level facts read live from NEAR testnet. */
export interface ApiProof {
  at: number; contract: string; codeHash: { hex: string; b58: string } | null
  model: string; signatureKind: string; forgeMode: string; forgeProject: string; mpcSigner: string; owner: string
  pending: { forgeMode: string | null; requestChange: boolean; activatesAt: number } | null
  allowlist: string[]; allowlistPending: string[] | null; allowlistDelaySec: number; relayers: string[]; vrfPinned: boolean
  request: { prefixSha256: string; suffixSha256: string; matchesSite: boolean }
  gates: { ok: boolean; ready: boolean; failing: { gate: string; why: string; blocking: boolean }[] }
  solvency: { balance: string; storage_cost: string; owed: string; endowment: string; deficit: string; players_covered: boolean }
  caps: { daily: number; total: number; today: number; used: number; open: boolean }
}

export interface ApiPreview {
  spec: import('./types').Spec; canonical: boolean; portrait: string | null; hash: string; signer?: string; verified?: boolean
  raw?: string; signature?: { text: string; signing_address: string; signature: string; kind: string }
  requestSha256?: string; responseSha256?: string
}

const FRIENDLY: Record<string, string> = {
  RATE_LIMITED: 'Slow down a little and try again in a moment.',
  SPONSOR_DRY: 'The guest faucet is empty right now. Try again later or connect your own wallet.',
  REFUSED: 'The referee refused this sentence. Try a different one.',
  AI_UNAVAILABLE: 'The AI referee is offline right now.',
  NOT_DEPLOYED: 'The game is not live yet.',
}

export class Api {
  constructor(private base = '', private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await this.fetchFn(this.base + path, init)
    } catch {
      throw new GameError('E_NETWORK', 'Could not reach the game server. Check your connection and try again.')
    }
    let body: unknown = null
    try { body = await res.json() } catch { /* non-JSON body */ }
    if (!res.ok) {
      const b = body as { error?: string; code?: string } | null
      const code = b?.code ?? `HTTP_${res.status}`
      throw new GameError(code, FRIENDLY[code] ?? b?.error ?? 'The server could not do that. Try again.')
    }
    return body as T
  }

  state = () => this.request<ApiState>('/api/state')
  proof = () => this.request<ApiProof>('/api/proof')
  stateFull = () => this.request<ApiStateFull>('/api/state')
  preview = (sentence: string) => this.request<ApiPreview>('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) })
  guest = (publicKey: string, sessionKey: string) => this.request<{ accountId: string }>('/api/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey, sessionKey }) })
}
