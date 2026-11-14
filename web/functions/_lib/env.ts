// Bindings, secrets and vars of the `title-shot` Pages project. Secrets: `wrangler pages secret put` (never in files).
export interface KVLike {
  get(key: string): Promise<string | null>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  put(key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface Env {
  TS_KV: KVLike
  // vars
  CONTRACT_ID?: string
  NEAR_RPC_URLS?: string // comma separated
  BASE_RPC_URLS?: string // comma separated
  SPONSOR_ID?: string
  VANCE_ID?: string
  RELAYER_ID?: string
  PURSE_WEI?: string
  SEASON_SEC?: string
  NEARAI_MODEL?: string
  SPONSOR_FLOOR_NEAR?: string // default 0.8
  GUEST_DEPOSIT_NEAR?: string // default 0.3: credited to a new guest's contract balance
  GUEST_GAS_NEAR?: string // default 0.1: transferred to a new guest account for gas (also the session key's allowance)
  MPC_SIGNER?: string
  COMPILER_MODE?: string // 'standin' = staging referee (only when NEARAI_API_KEY is absent)
  // NEAR AI spend (docs/BUDGET.md), set per key by scripts/rotate-nearai-key.sh as Pages secrets
  NEARAI_BUDGET_USD?: string // lifetime hard stop for the current key, default 2.5
  NEARAI_PUBLIC_DAILY_USD?: string // public (non-owner) spend per UTC day, default 0.05
  NEARAI_PUBLIC_TOTAL_USD?: string // public spend over the key's lifetime, default 0.25
  // secrets
  NEARAI_API_KEY?: string
  STANDIN_SIGNER_KEY?: string // 32-byte hex private key of the staging stand-in referee
  ELEVENLABS_API_KEY?: string
  SPONSOR_KEY?: string
  VANCE_KEY?: string
  RELAYER_KEY?: string
  TICK_SECRET?: string
  BOXOFFICE_PRICE_USDC?: string // boxoffice: price of one title shot in test USDC, default 0.25 (docs/BOXOFFICE.md)
  BOXOFFICE_FACILITATOR_URL?: string // boxoffice: x402 facilitator, default https://x402.org/facilitator
  BOXOFFICE_PAY_TO?: string // boxoffice: override of Vance's derived Base address (normally derived live)
  BOXOFFICE_DAILY_MAX?: string // boxoffice: paid bookings per UTC day, default 40
  BOXOFFICE_OFF?: string // boxoffice: '1' closes the box office (quotes still answer)
  BOXOFFICE_SEED?: string // boxoffice: secret that derives custodial guest keys (default: derived from SPONSOR_KEY)
  HOUSE_A_KEY?: string // house: function-call key (challenge only) of house-a.titleshot.testnet
  HOUSE_B_KEY?: string // house: function-call key (challenge only) of house-b.titleshot.testnet
  HOUSE_A_ID?: string // house: default house-a.titleshot.testnet
  HOUSE_B_ID?: string // house: default house-b.titleshot.testnet
  HOUSE_EVERY_MIN?: string // house: minutes without a bout before a house NPC challenges a belt (default 25)
  HOUSE_COMPILES_PER_DAY?: string // house: new fighters (compiles) the house may forge per UTC day (default 12), then it re-fields forged ones
}

export const DEFAULTS = {
  sponsorId: 'play.titleshot.testnet',
  vanceId: 'vance.titleshot.testnet',
  relayerId: 'relay.titleshot.testnet',
  mpcSigner: 'v1.signer-prod.testnet',
  model: 'z-ai/glm-5.3-flash',
  purseWei: 2_000_000_000_000_000n, // 0.002 ETH
  seasonSec: 6 * 3600,
  sponsorFloorNear: 0.8,
  nearAiBase: 'https://cloud-api.near.ai',
  baseRpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
}

export const list = (s: string | undefined): string[] | undefined => {
  const v = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return v.length ? v : undefined
}
