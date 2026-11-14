// Guest accounts: <adjective>-<noun>-<nn>.play.titleshot.testnet, funded by the sponsor, playable without a wallet popup.
import { GAS_CHALLENGE, GUEST_DEPOSIT, GUEST_FUND_GAS } from '../../src/game/chain/config'
import { b58decode } from '../../src/game/chain/base58'
import { Rpc, RpcError } from '../../src/game/chain/rpc'
import { Signer, TGAS, NEAR } from '../../src/game/chain/signer'
import { fn } from '../../src/game/chain/tx'
import { z } from 'zod'
import { getJson, putJson, scoped } from './cache'
import { DEFAULTS, type Env, type KVLike } from './env'
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
  /** yocto sent to the guest account for gas (default GUEST_FUND_GAS); the session key's allowance is `sessionAllowance` */
  gas?: bigint
  rand?: (max: number) => number
  /** where a guest is remembered by its full-access public key, so a retry resumes it instead of funding a second one */
  kv?: KVLike
}

/** Prepaid gas of one `challenge` at the testnet minimum gas price (1e8 yocto/gas): 0.03 NEAR. NEAR refunds unused gas to the
 *  account balance but never to a function-call key's allowance, so the allowance is spent at this rate per fight. */
const PREPAID_PER_CHALLENGE = GAS_CHALLENGE * 100_000_000n
const MIN_TOLL = NEAR / 20n

/** The session key's allowance: enough prepaid gas for every toll the deposit can pay (at 0.05 NEAR a toll), with 50% headroom,
 *  and never less than the gas transfer. It only caps what the key may spend of the guest's own balance. */
export function sessionAllowance(deposit: bigint, gas: bigint): bigint {
  const fights = (deposit + MIN_TOLL - 1n) / MIN_TOLL
  const need = (fights * PREPAID_PER_CHALLENGE * 3n) / 2n
  return need > gas ? need : gas
}

interface GuestRecord { accountId: string; funded: boolean }
const GUEST_RECORD_SEC = 7 * 86_400
export const guestKey = (contract: string, publicKey: string) => scoped(contract, `guest:${publicKey}`)

/** A guest this public key already started (resumed without the per-IP limit: it creates and funds nothing new). */
export async function knownGuest(kv: KVLike, contract: string, publicKey: string): Promise<GuestRecord | null> {
  return getJson<GuestRecord>(kv, guestKey(contract, publicKey))
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

const exists = (d: GuestDeps, id: string): Promise<boolean> =>
  d.near.balance(id).then(() => true, (e: unknown) => { if (e instanceof RpcError && /UNKNOWN_ACCOUNT/.test(e.kind)) return false; throw e })

/** Has the guest's contract balance been credited? null = could not tell (then nothing is paid: the client retries). */
const credited = (d: GuestDeps, id: string): Promise<boolean | null> =>
  d.near.view<string>(d.contract, 'balance_of', { account: id }).then((b) => BigInt(String(b ?? '0')) > 0n, () => null)

async function floorCheck(d: GuestDeps): Promise<void> {
  const balance = await d.near.balance(d.sponsor.accountId).catch(() => 0n)
  if (balance < BigInt(Math.round(d.floorNear * 1e6)) * (NEAR / 1_000_000n)) throw new ApiError(503, 'SPONSOR_DRY', 'The guest faucet is empty right now. Try again later.')
}
const depositFailed = () => new ApiError(502, 'GUEST_DEPOSIT_FAILED', 'The guest account was created but could not be funded yet. Try again: the same account is reused.')

/**
 * Creates the account (full-access key + a `challenge`-only session key) and credits its contract balance. Re-entrant: the
 * account is remembered by its full-access public key before anything is sent, so a client that retries after an error or a
 * timeout gets the same account back (created or funded only where that is still missing), never a second sponsored guest.
 */
export async function createGuest(d: GuestDeps, body: z.infer<typeof guestBody>): Promise<{ accountId: string }> {
  const deposit = d.deposit ?? GUEST_DEPOSIT
  const gas = d.gas ?? GUEST_FUND_GAS
  const key = guestKey(d.contract, body.publicKey)
  const known = d.kv ? await knownGuest(d.kv, d.contract, body.publicKey) : null
  if (known?.funded) return { accountId: known.accountId }
  const remember = async (r: GuestRecord) => { if (d.kv) await putJson(d.kv, key, r, GUEST_RECORD_SEC) }

  let accountId = known?.accountId ?? ''
  const created = !!accountId && (await exists(d, accountId))
  if (created) {
    // the record is ours only when the account really carries this full-access key
    const owns = await d.near.accessKeyNonce(accountId, body.publicKey).then(() => true, () => false)
    if (!owns) throw new ApiError(502, 'GUEST_CREATE_FAILED', 'Could not create the guest account. Try again.')
  }
  if (!created) {
    await floorCheck(d)
    const rand = d.rand ?? randomInt
    for (let i = 0; i < 6 && !accountId; i++) {
      const candidate = guestName(d.sponsor.accountId, rand)
      if (!(await exists(d, candidate))) accountId = candidate
    }
    if (!accountId) throw new ApiError(503, 'NAME_COLLISION', 'Could not pick a free guest name. Try again.')
    await remember({ accountId, funded: false }) // before the send: a timeout below still leaves a way back to this account
    const hash = await d.sponsor.send(accountId, [
      { kind: 'createAccount' },
      { kind: 'transfer', deposit: gas },
      { kind: 'addKeyFullAccess', publicKey: body.publicKey },
      { kind: 'addKeyFunctionCall', publicKey: body.sessionKey, allowance: sessionAllowance(deposit, gas), receiverId: d.contract, methodNames: ['challenge'] },
    ])
    const out = await d.sponsor.wait(hash, 60_000).catch(() => null) // a timeout is not a failure: the account may exist
    if (out?.failure || (!out && !(await exists(d, accountId).catch(() => false)))) throw new ApiError(502, 'GUEST_CREATE_FAILED', 'Could not create the guest account. Try again.')
  }
  // a resumed guest may already have been credited by a deposit whose wait timed out
  let check = !!known
  for (let attempt = 0; attempt < 2; attempt++) {
    if (check) {
      const paid = await credited(d, accountId)
      if (paid === null) throw depositFailed()
      if (paid) { await remember({ accountId, funded: true }); return { accountId } }
    }
    if (created && attempt === 0) await floorCheck(d) // a resumed guest: the sponsor floor still holds for its deposit
    const dep = await d.sponsor.wait(await d.sponsor.send(d.contract, [fn('deposit_for', { account: accountId }, 30n * TGAS, deposit)]), 60_000).catch(() => null)
    if (dep && !dep.failure) { await remember({ accountId, funded: true }); return { accountId } }
    check = !dep // after a timeout, look before paying again
  }
  throw depositFailed()
}
