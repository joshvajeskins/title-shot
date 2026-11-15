import { describe, expect, it, vi } from 'vitest'
import type { NearWalletBase } from '@hot-labs/near-connect'
import { Rpc } from '../src/game/chain/rpc'
import { formatSecretKey, generateKeyPair } from '../src/game/chain/keys'
import { assertRefused, CHEAT_IDS, fireCheat, planCheat, readOutcome, U128_MAX, type CheatContext, type CheatPlan } from '../src/game/cheats'
import type { StoredAccount } from '../src/game/nearKeys'

const ME = 'judge-1.play.titleshot.testnet'
const CONTRACT = 'ring.titleshot.testnet'
const ctx = (over: Partial<CheatContext> = {}): CheatContext => ({
  me: ME, relayers: ['relay.titleshot.testnet'], challengeId: 140, balanceYocto: '290000000000000000000000',
  payouts: [{ id: 29, payee: 'vance.titleshot.testnet', to: '0xedc7423225a2afc44375cf36feffc4119b484d49' }, { id: 30, payee: 'house-a.titleshot.testnet', to: null }, { id: 31, payee: ME, to: null }],
  belts: [{ id: '1', name: 'The Midnight Belt', holder: ME }, { id: '2', name: 'The Tide Belt', holder: 'vance.titleshot.testnet' }],
  ...over,
})
const plan = (id: Parameters<typeof planCheat>[0], c = ctx()): CheatPlan => {
  const p = planCheat(id, c)
  if (!('plan' in p)) throw new Error(p.blocked)
  return p.plan
}

/** A failed function call as RPC `tx` returns it: the panic sits in the first receipt, the refund burns nothing. */
const failed = (hash: string, code: string) => ({
  status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } },
  transaction: { hash }, transaction_outcome: { id: hash, outcome: { tokens_burnt: '223182562500000000000', gas_burnt: 2231825625000, logs: [], status: { SuccessReceiptId: 'r1' } } },
  receipts_outcome: [
    { id: 'r1', outcome: { tokens_burnt: '310480000000000000000', gas_burnt: 3104800000000, logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } } } },
    { id: 'r2', outcome: { tokens_burnt: '0', gas_burnt: 223182562500, logs: [], status: { SuccessValue: '' } } },
  ],
})

describe('cheat plans: only calls the contract must refuse', () => {
  it('every cheat has a plan with the code the contract source gives', () => {
    expect(CHEAT_IDS.map((id) => plan(id).expect)).toEqual(['E_NOT_RELAYER', 'E_NOT_PAYEE', 'E_NOT_HOLDER', 'E_BALANCE'])
    expect(plan('withdraw').args).toEqual({ amount: U128_MAX })
    expect(plan('forge').deposit).toBe(0n)
    expect(['claim', 'belt', 'withdraw'].map((id) => plan(id as 'claim').deposit)).toEqual([1n, 1n, 1n])
  })

  it('claim picks someone else’s payout (an unclaimed one first), never the player’s own', () => {
    expect(plan('claim').args.payout_id).toBe(30)
    const onlyMine = planCheat('claim', ctx({ payouts: [{ id: 31, payee: ME, to: null }] }))
    expect('blocked' in onlyMine).toBe(true)
  })

  it('the belt always goes to the sender: a belt held by another gives E_NOT_HOLDER, and holding every belt still refuses (E_SELF)', () => {
    expect(plan('belt').args).toMatchObject({ receiver_id: ME, token_id: 'belt-2', approval_id: null })
    const all = plan('belt', ctx({ belts: [{ id: '1', name: 'The Midnight Belt', holder: ME }] }))
    expect(all).toMatchObject({ expect: 'E_SELF', args: { receiver_id: ME, token_id: 'belt-1' } })
  })

  it('the forge cheat waits for the relayer list and is never offered to a relayer', () => {
    expect('blocked' in planCheat('forge', ctx({ relayers: null }))).toBe(true)
    expect('blocked' in planCheat('forge', ctx({ me: 'relay.titleshot.testnet' }))).toBe(true)
  })

  it('assertRefused stops any plan that could succeed', () => {
    const c = ctx()
    expect(() => assertRefused({ ...plan('claim'), args: { payout_id: 31, addr: '0x00' } }, c)).toThrow(/could be yours/)
    expect(() => assertRefused({ ...plan('claim'), args: { payout_id: 99, addr: '0x00' } }, c)).toThrow(/could be yours/)
    expect(() => assertRefused({ ...plan('belt'), args: { ...plan('belt').args, receiver_id: 'friend.testnet' } }, c)).toThrow(/someone else/)
    expect(() => assertRefused({ ...plan('withdraw'), args: { amount: '1' } }, c)).toThrow(/fit a balance/)
    expect(() => assertRefused(plan('forge'), { ...c, me: 'relay.titleshot.testnet' })).toThrow(/relayer/)
    expect(() => assertRefused({ ...plan('withdraw'), deposit: 2n }, c)).toThrow(/yoctoNEAR/)
    expect(() => assertRefused({ ...plan('withdraw'), method: 'deposit' as 'withdraw' }, c)).toThrow(/unknown method/)
    for (const id of CHEAT_IDS) expect(() => assertRefused(plan(id), c)).not.toThrow()
  })
})

describe('reading the refusal', () => {
  it('takes the code from the failed receipt and sums the NEAR every outcome burnt', () => {
    const r = readOutcome('H1', failed('H1', 'E_NOT_PAYEE'))
    expect(r).toMatchObject({ hash: 'H1', code: 'E_NOT_PAYEE', succeeded: false })
    expect(r.burntYocto).toBe(533662562500000000000n)
    expect(r.gasBurnt).toBe(5559808187500n)
  })
  it('a success is reported as a success, never as a refusal', () => {
    const ok = { status: { SuccessValue: '' }, transaction_outcome: { outcome: { tokens_burnt: '1', gas_burnt: 1 } }, receipts_outcome: [{ outcome: { tokens_burnt: '2', gas_burnt: 2, status: { SuccessValue: '' } } }] }
    expect(readOutcome('H2', ok)).toMatchObject({ succeeded: true, code: null, burntYocto: 3n })
  })
})

/** A fake RPC that logs every call and answers `tx` with `outcome`. */
function chain(events: string[], outcome: unknown, nearHeld = 10n ** 23n) {
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    events.push(`rpc:${method === 'query' ? params.request_type : method}`)
    const result = method === 'tx' ? outcome : method === 'block' ? { header: { hash: '11111111111111111111111111111111' } } : method === 'query' ? (params.request_type === 'view_account' ? { amount: nearHeld.toString(), storage_usage: 300 } : { nonce: 5, permission: 'FullAccess' }) : null
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }) as unknown as typeof fetch
  return new Rpc({ urls: ['http://rpc'], fetchFn })
}
const stored = (kind: 'wallet' | 'guest'): StoredAccount => ({ accountId: ME, fullKey: kind === 'guest' ? formatSecretKey(generateKeyPair()) : '', sessionKey: '', createdAt: 0, kind } as StoredAccount)

describe('sending a cheat', () => {
  it('a wallet account: the tap reaches the wallet before any network request, and the code is read back from our RPC', async () => {
    const events: string[] = []
    const rpc = chain(events, failed('9xWalletTxHash1111111111111111111111111111111', 'E_NOT_HOLDER'))
    const wallet = {
      manifest: { id: 'meteor-wallet', name: 'Meteor Wallet', features: {} },
      // the wallet's own outcome says nothing useful: what is shown must come from the chain read
      signAndSendTransaction: vi.fn(async (p: { actions: { params: { methodName: string; deposit: string } }[] }) => { events.push(`wallet:${p.actions[0]!.params.methodName}:${p.actions[0]!.params.deposit}`); return { transaction: { hash: '9xWalletTxHash1111111111111111111111111111111' }, status: { SuccessValue: '' }, receipts_outcome: [] } }),
    } as unknown as NearWalletBase
    const r = await fireCheat(plan('belt'), ctx(), { rpc, contract: CONTRACT, stored: stored('wallet'), wallet, sleep: async () => undefined })
    expect(events[0]).toBe('wallet:nft_transfer:1')
    expect(events.slice(1).every((e) => e === 'rpc:tx')).toBe(true)
    expect(r).toMatchObject({ code: 'E_NOT_HOLDER', succeeded: false })
  })

  it('a wallet that throws on the failed transaction: its hash is read back like any other', async () => {
    const events: string[] = []
    const hash = '7GvFqH3kq2mWZp4rT9sYb8aXc5dEeNfLgMhJiKkPpQrS'
    const rpc = chain(events, failed(hash, 'E_BALANCE'))
    const wallet = { manifest: { id: 'w', name: 'W', features: {} }, signAndSendTransaction: vi.fn(async () => { throw new Error(`Transaction ${hash} failed: Smart contract panicked: E_BALANCE`) }) } as unknown as NearWalletBase
    const r = await fireCheat(plan('withdraw'), ctx(), { rpc, contract: CONTRACT, stored: stored('wallet'), wallet, sleep: async () => undefined })
    expect(r).toMatchObject({ hash, code: 'E_BALANCE' })
  })

  it('a declined approval sends nothing and says so', async () => {
    const wallet = { manifest: { id: 'w', name: 'W', features: {} }, signAndSendTransaction: vi.fn(async () => { throw new Error('User rejected the request') }) } as unknown as NearWalletBase
    await expect(fireCheat(plan('claim'), ctx(), { rpc: chain([], null), contract: CONTRACT, stored: stored('wallet'), wallet })).rejects.toMatchObject({ code: 'E_WALLET_REJECTED' })
  })

  it('a judge demo account signs with its own full key and reads the outcome back', async () => {
    const events: string[] = []
    const rpc = chain(events, failed('ignored', 'E_NOT_RELAYER'))
    const r = await fireCheat(plan('forge'), ctx(), { rpc, contract: CONTRACT, stored: stored('guest'), sleep: async () => undefined })
    expect(events).toEqual(['rpc:view_account', 'rpc:view_access_key', 'rpc:block', 'rpc:send_tx', 'rpc:tx'])
    expect(r).toMatchObject({ code: 'E_NOT_RELAYER', succeeded: false })
  })

  it('a judge demo account without the gas money up front is told so instead of sending a transaction that would be dropped', async () => {
    const events: string[] = []
    await expect(fireCheat(plan('withdraw'), ctx(), { rpc: chain(events, null, 9n * 10n ** 21n), contract: CONTRACT, stored: stored('guest') })).rejects.toMatchObject({ code: 'E_GAS_BALANCE' })
    expect(events).toEqual(['rpc:view_account'])
  })

  it('an unsafe plan is never signed', async () => {
    const wallet = { manifest: { id: 'w', name: 'W', features: {} }, signAndSendTransaction: vi.fn() } as unknown as NearWalletBase
    await expect(fireCheat({ ...plan('claim'), args: { payout_id: 31, addr: '0x00' } }, ctx(), { rpc: chain([], null), contract: CONTRACT, stored: stored('wallet'), wallet })).rejects.toMatchObject({ code: 'E_UNSAFE_CHEAT' })
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled()
  })
})
