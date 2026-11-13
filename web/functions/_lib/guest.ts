// Guest accounts: <adjective>-<noun>-<nn>.play.titleshot.testnet, funded by the sponsor, playable without a wallet popup.
import { GUEST_DEPOSIT, GUEST_FUND_GAS } from '../../src/game/chain/config'
import { b58decode } from '../../src/game/chain/base58'
import { Rpc, RpcError } from '../../src/game/chain/rpc'
import { Signer, TGAS, NEAR } from '../../src/game/chain/signer'
import { fn } from '../../src/game/chain/tx'
import { z } from 'zod'
import { DEFAULTS, type Env } from './env'
import { ApiError } from './http'

const ADJECTIVES = ['brave', 'sneaky', 'rowdy', 'mighty', 'dizzy', 'fierce', 'cheeky', 'grumpy', 'swift', 'lucky', 'feral', 'jolly', 'noble', 'salty', 'zesty', 'plucky']
const NOUNS = ['badger', 'walrus', 'pigeon', 'otter', 'goose', 'hornet', 'mantis', 'yeti', 'toaster', 'kraken', 'gecko', 'moose', 'raven', 'weasel', 'bison', 'narwhal']

export function guestName(sponsorId: string, rand: (max: number) => number): string {
  const nn = String(rand(100)).padStart(2, '0')
  return `${ADJECTIVES[rand(ADJECTIVES.length)]}-${NOUNS[rand(NOUNS.length)]}-${nn}.${sponsorId}`
}

export const randomInt = (max: number): number => {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return b[0]! % max
}

const edKey = z.string().max(80).refine((s) => {
  if (!s.startsWith('ed25519:')) return false
  try { return b58decode(s.slice(8)).length === 32 } catch { return false }
}, 'expected an ed25519:<base58> public key')

export const guestBody = z.object({ publicKey: edKey, sessionKey: edKey }).strict().refine((b) => b.publicKey !== b.sessionKey, { message: 'publicKey and sessionKey must differ' })

export interface GuestDeps {
  sponsor: Signer
  near: Rpc
  contract: string
  floorNear: number
  /** yocto credited to the guest's contract balance (default GUEST_DEPOSIT) */
  deposit?: bigint
  /** yocto sent to the guest account for gas; also the session key's allowance (default GUEST_FUND_GAS) */
  gas?: bigint
  rand?: (max: number) => number
}

export const floorOf = (v: string | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.sponsorFloorNear
}

/** "0.3" -> yocto. Plain decimals only, greater than 0 and at most 10 NEAR; anything else is the default (a typo must not drain the sponsor). */
export function parseNear(v: string | undefined, fallback: bigint): bigint {
  const m = /^(\d{1,2})(?:\.(\d{1,24}))?$/.exec((v ?? '').trim())
  if (!m) return fallback
  const yocto = BigInt(m[1]!) * NEAR + BigInt((m[2] ?? '').padEnd(24, '0') || '0')
  return yocto > 0n && yocto <= 10n * NEAR ? yocto : fallback
}

/** Guest economics from the Pages vars: GUEST_DEPOSIT_NEAR (0.3), GUEST_GAS_NEAR (0.1), SPONSOR_FLOOR_NEAR (0.8). */
export function economicsOf(env: Env): { deposit: bigint; gas: bigint; floorNear: number } {
  return { deposit: parseNear(env.GUEST_DEPOSIT_NEAR, GUEST_DEPOSIT), gas: parseNear(env.GUEST_GAS_NEAR, GUEST_FUND_GAS), floorNear: floorOf(env.SPONSOR_FLOOR_NEAR) }
}

/** Creates the account (full-access key + a `challenge`-only session key) and credits its contract balance. */
export async function createGuest(d: GuestDeps, body: z.infer<typeof guestBody>): Promise<{ accountId: string }> {
  const balance = await d.near.balance(d.sponsor.accountId).catch(() => 0n)
  if (balance < BigInt(Math.round(d.floorNear * 1e6)) * (NEAR / 1_000_000n)) throw new ApiError(503, 'SPONSOR_DRY', 'The guest faucet is empty right now. Try again later.')
  const rand = d.rand ?? randomInt
  const deposit = d.deposit ?? GUEST_DEPOSIT
  const gas = d.gas ?? GUEST_FUND_GAS
  let accountId = ''
  for (let i = 0; i < 6 && !accountId; i++) {
    const candidate = guestName(d.sponsor.accountId, rand)
    const taken = await d.near.balance(candidate).then(() => true, (e: unknown) => { if (e instanceof RpcError && /UNKNOWN_ACCOUNT/.test(e.kind)) return false; throw e })
    if (!taken) accountId = candidate
  }
  if (!accountId) throw new ApiError(503, 'NAME_COLLISION', 'Could not pick a free guest name. Try again.')
  const hash = await d.sponsor.send(accountId, [
    { kind: 'createAccount' },
    { kind: 'transfer', deposit: gas },
    { kind: 'addKeyFullAccess', publicKey: body.publicKey },
    { kind: 'addKeyFunctionCall', publicKey: body.sessionKey, allowance: gas, receiverId: d.contract, methodNames: ['challenge'] },
  ])
  const created = await d.sponsor.wait(hash, 60_000)
  if (created.failure) throw new ApiError(502, 'GUEST_CREATE_FAILED', 'Could not create the guest account. Try again.')
  for (let attempt = 0; attempt < 2; attempt++) {
    const dep = await d.sponsor.wait(await d.sponsor.send(d.contract, [fn('deposit_for', { account: accountId }, 30n * TGAS, deposit)]), 60_000)
    if (!dep.failure) return { accountId }
  }
  throw new ApiError(502, 'GUEST_DEPOSIT_FAILED', 'The guest account was created but could not be funded. Try again.')
}
