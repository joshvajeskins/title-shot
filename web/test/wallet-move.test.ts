// "Move to my wallet": what a guest's full-access key signs, in which order, and how much NEAR stays behind.
import { describe, expect, it } from 'vitest'
import { Rpc } from '../src/game/chain/rpc'
import { formatSecretKey, generateKeyPair } from '../src/game/chain/keys'
import { fromUtf8, utf8 } from '../src/game/chain/bytes'
import { Signer } from '../src/game/chain/signer'
import type { Action } from '../src/game/chain/tx'
import { arriving, executeMove, MOVE_MARGIN, planMove, type MoveStep } from '../src/game/wallet/move'

const NEAR = 10n ** 24n
const CONTRACT = 'ring.titleshot.testnet'
const GUEST = 'brave-otter-01.play.titleshot.testnet'
const WALLET = 'alice.testnet'
const STORAGE = 400 // bytes -> 0.004 NEAR

function world(o: { balance?: bigint; belts?: string[]; pending?: boolean; amount?: bigint } = {}) {
  const state = { balance: o.balance ?? NEAR / 4n, belts: o.belts ?? ['belt-1'], amount: o.amount ?? NEAR / 10n }
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
    if (method === 'query' && params.request_type === 'view_account') return ok({ amount: state.amount.toString(), storage_usage: STORAGE })
    if (method === 'query' && params.request_type === 'call_function') {
      const m = params.method_name
      const out = m === 'balance_of' ? state.balance.toString() : m === 'nft_tokens_for_owner' ? state.belts.map((t) => ({ token_id: t, metadata: { title: t === 'belt-1' ? 'Tide Belt' : t } })) : m === 'get_pending' ? (o.pending ? { id: 9 } : null) : null
      return ok({ result: Array.from(utf8(JSON.stringify(out))), logs: [] })
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN' }, message: 'x' } }))
  }) as unknown as typeof fetch
  const rpc = new Rpc({ urls: ['http://rpc'], fetchFn })
  const sent: { receiverId: string; actions: Action[] }[] = []
  const signer = Object.assign(Object.create(Signer.prototype), {
    accountId: GUEST,
    send: async (receiverId: string, actions: Action[]) => {
      sent.push({ receiverId, actions })
      for (const a of actions) {
        if (a.kind === 'functionCall' && a.method === 'withdraw') { state.amount += state.balance; state.balance = 0n }
        if (a.kind === 'functionCall' && a.method === 'nft_transfer') state.belts = state.belts.filter((b) => b !== JSON.parse(fromUtf8(a.args)).token_id)
        if (a.kind === 'transfer') state.amount -= a.deposit
      }
      return `tx${sent.length}`
    },
    wait: async () => ({ failure: null, value: null, logs: [], events: [], status: 'SuccessValue', raw: {} }),
  }) as Signer
  return { rpc, signer, sent, state }
}

const fullKey = formatSecretKey(generateKeyPair())

describe('move plan: exactly what will move', () => {
  it('reads the game balance, every belt, and the account NEAR minus storage and a margin', async () => {
    const w = world()
    const p = await planMove(w.rpc, CONTRACT, GUEST, WALLET)
    expect(p.balance).toBe(NEAR / 4n)
    expect(p.belts).toEqual([{ tokenId: 'belt-1', name: 'Tide Belt' }])
    const reserve = BigInt(STORAGE) * 10n ** 19n + MOVE_MARGIN
    expect(p.reserve).toBe(reserve)
    expect(p.accountNear).toBe(NEAR / 10n - reserve)
    expect(arriving(p)).toBe(NEAR / 4n + NEAR / 10n - reserve)
    expect(p.pending).toBe(false)
  })
  it('refuses moving a guest to itself', async () => {
    await expect(planMove(world().rpc, CONTRACT, GUEST, GUEST)).rejects.toMatchObject({ code: 'E_SAME_ACCOUNT' })
  })
})

describe('move execution: signed by the guest key, withdraw -> belts -> NEAR', () => {
  it('runs the three steps in order and leaves only storage + margin behind', async () => {
    const w = world({ belts: ['belt-1', 'belt-3'] })
    const steps: MoveStep[] = []
    const plan = await planMove(w.rpc, CONTRACT, GUEST, WALLET)
    const receipts = await executeMove(plan, { rpc: w.rpc, contract: CONTRACT, fullKey, signer: w.signer, onStep: (s) => steps.push(s) })
    expect(w.sent.map((t) => [t.receiverId, t.actions.map((a) => (a.kind === 'functionCall' ? a.method : a.kind))])).toEqual([
      [CONTRACT, ['withdraw']],
      [CONTRACT, ['nft_transfer', 'nft_transfer']],
      [WALLET, ['transfer']],
    ])
    const withdraw = w.sent[0]!.actions[0] as Extract<Action, { kind: 'functionCall' }>
    expect(withdraw.deposit).toBe(1n)
    const xfer = w.sent[1]!.actions[0] as Extract<Action, { kind: 'functionCall' }>
    expect(JSON.parse(fromUtf8(xfer.args))).toMatchObject({ receiver_id: WALLET, token_id: 'belt-1' })
    expect(xfer.deposit).toBe(1n)
    const sentNear = (w.sent[2]!.actions[0] as Extract<Action, { kind: 'transfer' }>).deposit
    expect(sentNear).toBe(NEAR / 4n + NEAR / 10n - BigInt(STORAGE) * 10n ** 19n - MOVE_MARGIN)
    expect(w.state.amount).toBe(BigInt(STORAGE) * 10n ** 19n + MOVE_MARGIN)
    expect(receipts.map((r) => r.url)).toEqual(['https://testnet.nearblocks.io/txns/tx1', 'https://testnet.nearblocks.io/txns/tx2', 'https://testnet.nearblocks.io/txns/tx3'])
    expect(steps.filter((s) => s.status === 'done').map((s) => s.id)).toEqual(['withdraw', 'belts', 'near'])
  })
  it('skips what is empty: no balance, no belts', async () => {
    const w = world({ balance: 0n, belts: [] })
    const steps: MoveStep[] = []
    await executeMove(await planMove(w.rpc, CONTRACT, GUEST, WALLET), { rpc: w.rpc, contract: CONTRACT, fullKey, signer: w.signer, onStep: (s) => steps.push(s) })
    expect(steps.filter((s) => s.status === 'skipped').map((s) => s.id)).toEqual(['withdraw', 'belts'])
    expect(w.sent).toHaveLength(1)
  })
  it('never sends NEAR the guest cannot spare', async () => {
    const w = world({ balance: 0n, belts: [], amount: BigInt(STORAGE) * 10n ** 19n + MOVE_MARGIN / 2n })
    const steps: MoveStep[] = []
    await executeMove(await planMove(w.rpc, CONTRACT, GUEST, WALLET), { rpc: w.rpc, contract: CONTRACT, fullKey, signer: w.signer, onStep: (s) => steps.push(s) })
    expect(w.sent).toHaveLength(0)
    expect(steps.every((s) => s.status === 'skipped')).toBe(true)
  })
  it('refuses while a fight is forging (its toll is locked)', async () => {
    const w = world({ pending: true })
    const plan = await planMove(w.rpc, CONTRACT, GUEST, WALLET)
    expect(plan.pending).toBe(true)
    await expect(executeMove(plan, { rpc: w.rpc, contract: CONTRACT, fullKey, signer: w.signer, onStep: () => undefined })).rejects.toMatchObject({ code: 'E_PENDING' })
    expect(w.sent).toHaveLength(0)
  })
  it('a failed step stops the move and reports the tx', async () => {
    const w = world()
    ;(w.signer as unknown as { wait: unknown }).wait = async () => ({ failure: '{"ActionError":"Smart contract panicked: E_NOT_HOLDER"}', value: null, logs: [], events: [], status: 'Failure', raw: {} })
    const steps: MoveStep[] = []
    await expect(executeMove(await planMove(w.rpc, CONTRACT, GUEST, WALLET), { rpc: w.rpc, contract: CONTRACT, fullKey, signer: w.signer, onStep: (s) => steps.push(s) })).rejects.toBeTruthy()
    const failed = steps.find((s) => s.status === 'failed')!
    expect(failed.id).toBe('withdraw')
    expect(failed.receipt?.tx).toBe('tx1')
    expect(w.sent).toHaveLength(1)
  })
})

