// "Move to my wallet": a guest hands everything to a NEAR wallet it has just proved it controls (NEP-413). Every step is
// signed in this browser by the guest's own full-access key: withdraw the game balance, nft_transfer each belt, then send
// the account's NEAR minus a small reserve for its own storage.
import { GameError } from '../client'
import { Rpc } from '../chain/rpc'
import { Signer, TGAS } from '../chain/signer'
import { parseSecretKey } from '../chain/keys'
import { fn, type Action } from '../chain/tx'
import { txUrl } from '../chain/config'
import { contractCode } from '../chain/rpc'
import { gameErrorFor, networkError } from '../chain/errors'
import type { Receipt } from './setup'

const NEAR = 10n ** 24n
/** yocto per byte of account storage on NEAR */
const STORAGE_PRICE = 10n ** 19n
/** Left on the guest after the final transfer, on top of its storage: the transfer's own gas, with room to spare. */
export const MOVE_MARGIN = NEAR / 100n // 0.01 NEAR
const BELTS_PER_TX = 10

export interface MoveBelt { tokenId: string; name: string }
export interface MovePlan {
  guestId: string
  target: string
  /** game balance withdrawn back to the guest first (then included in the transfer) */
  balance: bigint
  belts: MoveBelt[]
  /** the guest account's own NEAR, after its storage reserve */
  accountNear: bigint
  /** storage + margin that stays on the guest */
  reserve: bigint
  /** a fight still forging: its toll is locked, so the move waits */
  pending: boolean
}

/** NEAR the target should receive (game balance + account NEAR, minus the reserve). */
export const arriving = (p: MovePlan): bigint => (p.balance + p.accountNear > 0n ? p.balance + p.accountNear : 0n)

async function account(rpc: Rpc, id: string): Promise<{ amount: bigint; storage: bigint }> {
  const r = await rpc.call<{ amount: string; storage_usage?: number }>('query', { request_type: 'view_account', finality: 'final', account_id: id })
  return { amount: BigInt(r.amount), storage: BigInt(r.storage_usage ?? 0) * STORAGE_PRICE }
}

export async function planMove(rpc: Rpc, contract: string, guestId: string, target: string): Promise<MovePlan> {
  if (guestId === target) throw new GameError('E_SAME_ACCOUNT', 'That wallet is this guest account. Connect a different NEAR account.')
  try {
    const [bal, tokens, pending, acct] = await Promise.all([
      rpc.view<string>(contract, 'balance_of', { account: guestId }),
      rpc.view<{ token_id: string; metadata?: { title?: string } }[]>(contract, 'nft_tokens_for_owner', { account_id: guestId, from_index: null, limit: 50 }),
      rpc.view<unknown>(contract, 'get_pending', { account: guestId }),
      account(rpc, guestId),
    ])
    const reserve = acct.storage + MOVE_MARGIN
    const free = acct.amount - reserve
    return {
      guestId, target, balance: BigInt(String(bal ?? '0')),
      belts: (tokens ?? []).map((t) => ({ tokenId: t.token_id, name: t.metadata?.title ?? t.token_id })),
      accountNear: free > 0n ? free : 0n, reserve, pending: pending != null,
    }
  } catch (e) {
    throw e instanceof GameError ? e : networkError(e)
  }
}

export type MoveStepId = 'withdraw' | 'belts' | 'near'
export interface MoveStep { id: MoveStepId; status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'; receipt?: Receipt; note?: string }

export interface MoveDeps { rpc: Rpc; contract: string; fullKey: string; onStep: (s: MoveStep) => void; signer?: Signer }

async function run(signer: Signer, receiverId: string, actions: Action[]): Promise<string> {
  const hash = await signer.send(receiverId, actions)
  const out = await signer.wait(hash, 90_000, 'FINAL')
  if (out.failure) throw Object.assign(gameErrorFor(contractCode(out.failure) ?? 'E_TX_FAILED'), { hash })
  return hash
}

/** Run the three steps in order. A failed step stops the move; what already moved stays moved (each step is its own tx). */
export async function executeMove(plan: MovePlan, d: MoveDeps): Promise<Receipt[]> {
  if (plan.pending) throw new GameError('E_PENDING', 'A fight of yours is still being forged. Move once it has finished.')
  const signer = d.signer ?? new Signer(plan.guestId, parseSecretKey(d.fullKey), d.rpc)
  const receipts: Receipt[] = []
  const step = async (id: MoveStepId, skip: boolean, label: string, go: () => Promise<string>) => {
    if (skip) { d.onStep({ id, status: 'skipped' }); return }
    d.onStep({ id, status: 'running' })
    try {
      const hash = await go()
      const receipt = { label, tx: hash, url: txUrl(hash) }
      receipts.push(receipt)
      d.onStep({ id, status: 'done', receipt })
    } catch (e) {
      const hash = (e as { hash?: string }).hash
      d.onStep({ id, status: 'failed', note: e instanceof Error ? e.message : String(e), ...(hash ? { receipt: { label, tx: hash, url: txUrl(hash) } } : {}) })
      throw e instanceof GameError ? e : networkError(e)
    }
  }
  await step('withdraw', plan.balance <= 0n, 'game balance withdrawn', () => run(signer, d.contract, [fn('withdraw', { amount: null }, 30n * TGAS, 1n)]))
  await step('belts', plan.belts.length === 0, plan.belts.length === 1 ? 'belt transferred' : 'belts transferred', async () => {
    let last = ''
    for (let i = 0; i < plan.belts.length; i += BELTS_PER_TX) {
      const chunk = plan.belts.slice(i, i + BELTS_PER_TX)
      last = await run(signer, d.contract, chunk.map((b) => fn('nft_transfer', { receiver_id: plan.target, token_id: b.tokenId, approval_id: null, memo: 'Moved from a Title Shot guest corner' }, 20n * TGAS, 1n)))
    }
    return last
  })
  // re-read after the withdrawal landed: send what the account holds now, minus storage and the margin
  const now = await account(d.rpc, plan.guestId).catch((e) => { throw networkError(e) })
  const send = now.amount - now.storage - MOVE_MARGIN
  await step('near', send <= 0n, 'NEAR sent', () => run(signer, plan.target, [{ kind: 'transfer', deposit: send }]))
  return receipts
}
