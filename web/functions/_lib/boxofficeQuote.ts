// Box office (docs/BOXOFFICE.md): the price, where the money goes (Vance's Chain-Signatures Base address), and whether a
// belt can be booked right now. Every check here runs BEFORE a payment is settled, so nobody pays for a fight the
// contract would refuse.
import { formatNear } from '../../src/game/chain/errors'
import type { RawBelt, RawChallenge } from '../../src/game/chain/views'
import { cleanSentence } from '../../src/game/client'
import { sentenceHash } from '../../src/game/chain/views'
import { cachedJson, scoped } from './cache'
import type { Chain } from './chain'
import { DEFAULTS, type Env } from './env'
import { deriveEvmAddress } from './evm'
import { ApiError } from './http'
import { VANCE_PATH } from './purse'
import { formatUsdc, NETWORK, USDC_BASE_SEPOLIA, usdcUnits, DEFAULT_FACILITATOR } from './x402'

export const BOX_DAILY_DEFAULT = 40

export interface BoxConfig { amount: string; usdc: string; facilitator: string; dailyMax: number; open: boolean }

export function boxConfig(env: Env): BoxConfig {
  const amount = usdcUnits(env.BOXOFFICE_PRICE_USDC)
  const daily = Number(env.BOXOFFICE_DAILY_MAX)
  const fac = (env.BOXOFFICE_FACILITATOR_URL ?? '').trim()
  return {
    amount, usdc: formatUsdc(amount),
    facilitator: /^https:\/\/[^\s]+$/.test(fac) ? fac : DEFAULT_FACILITATOR,
    dailyMax: Number.isInteger(daily) && daily >= 0 && daily <= 10_000 ? daily : BOX_DAILY_DEFAULT,
    open: env.BOXOFFICE_OFF !== '1',
  }
}

/** Vance's Base Sepolia address (Chain Signatures, path `vance-purse`): an explicit override, else derived once and cached. */
export async function payToOf(env: Env, chain: Chain): Promise<string> {
  const o = (env.BOXOFFICE_PAY_TO ?? '').trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(o)) return o.toLowerCase()
  const vance = env.VANCE_ID ?? DEFAULTS.vanceId
  const mpc = env.MPC_SIGNER ?? DEFAULTS.mpcSigner
  try {
    return await cachedJson(env.TS_KV, scoped(chain.id, `boxoffice:payto:${vance}`), 3600, () => deriveEvmAddress(chain.rpc, mpc, VANCE_PATH, vance), 86_400)
  } catch {
    throw new ApiError(502, 'CHAIN_UNAVAILABLE', 'Could not look up the box office address. Try again in a moment.')
  }
}

export interface Unbookable { status: number; code: string; message: string }

/** Why this belt cannot take a challenge now (season, champion, the champion's own sentence), or null. */
export function beltProblem(belt: RawBelt | null, nowMs: number, sentence?: string): Unbookable | null {
  if (!belt) return { status: 404, code: 'NO_BELT', message: 'That belt does not exist.' }
  const s = belt.season
  if (!s || s.state !== 'Open' || Number(BigInt(s.closes_at) / 1_000_000n) <= nowMs) {
    return { status: 409, code: 'NO_SEASON', message: 'This belt has no open season right now. Ask for a quote again in a few minutes.' }
  }
  if (!belt.champion) return { status: 409, code: 'NO_CHAMPION', message: 'This belt has no champion yet: the promoter is still forging the opener.' }
  if (sentence !== undefined && sentenceHash(cleanSentence(sentence)) === belt.champion.hash) {
    return { status: 409, code: 'SAME_SENTENCE', message: 'That is the champion\'s own sentence. Write a different one.' }
  }
  return null
}

/** The checks that need more chain reads: the payer's own corner (holder / pending fight), deploy gates and the compile cap. */
export async function bookingProblem(chain: Chain, belt: RawBelt, sentence: string, guest: string | null): Promise<Unbookable | null> {
  if (guest && belt.holder === guest) return { status: 409, code: 'SELF', message: 'Your corner holds this belt. You cannot challenge yourself.' }
  const [gates, pending, caps, known] = await Promise.all([
    chain.deployGates(),
    guest ? chain.view<RawChallenge | null>('get_pending', { account: guest }) : Promise.resolve(null),
    chain.compileCaps(),
    chain.fighterBySentence(cleanSentence(sentence)),
  ])
  if (!gates.ready) return { status: 503, code: 'NOT_READY', message: 'The arena is not open yet. Try again later.' }
  if (pending) return { status: 409, code: 'PENDING', message: 'Your last challenge is still being forged. Wait for it to finish (about a minute).' }
  const open = (caps as { open?: boolean }).open ?? (caps.today < caps.daily && caps.used < caps.total)
  if (!open && !known) return { status: 503, code: 'FORGE_CLOSED', message: 'New fighters are paused for today (AI budget). A sentence that was already forged still works.' }
  return null
}

export interface BeltQuote {
  id: number; name: string; toll: { yocto: string; near: string }; forgeFee: string
  champion: { sentence: string; hash: string; writer: string } | null; holder: string | null
  season: { state: string; closesAt: number } | null; bookable: boolean; reason?: { code: string; message: string }
}

export function beltQuote(b: RawBelt, nowMs: number): BeltQuote {
  const p = beltProblem(b, nowMs)
  return {
    id: b.id, name: b.name, toll: { yocto: b.toll, near: formatNear(BigInt(b.toll), 3) }, forgeFee: b.forge_fee,
    champion: b.champion ? { sentence: b.champion.sentence, hash: b.champion.hash, writer: b.champion.writer } : null,
    holder: b.holder,
    season: b.season ? { state: b.season.state, closesAt: Number(BigInt(b.season.closes_at) / 1_000_000n) } : null,
    bookable: !p, ...(p ? { reason: { code: p.code, message: p.message } } : {}),
  }
}

/** The free quote: price, payTo, the honest rate note, and the belt(s). */
export function quoteBody(cfg: BoxConfig, payTo: string, resource: string, belts: BeltQuote[], contract: string) {
  return {
    x402Version: 2, open: cfg.open, contract, network: NETWORK, asset: USDC_BASE_SEPOLIA, payTo, facilitator: cfg.facilitator, resource,
    price: { usdc: cfg.usdc, amount: cfg.amount },
    rate: `${cfg.usdc} test USDC buys exactly one title shot: the house credits one toll in testnet NEAR at a fixed rate (no swap). The USDC stays with Velvet Vance on Base.`,
    split: { champion: 60, promoter: 25, sidePot: 10, protocol: 5, note: 'of each toll after the forge fee and storage, paid on NEAR' },
    belts,
  }
}
