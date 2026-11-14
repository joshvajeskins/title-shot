// "Add fight money": a wallet account deposits through its own wallet; a judge demo account is told how to keep playing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAccount } from '../src/game/nearKeys'

const sent: unknown[] = []
let reject = false
vi.mock('../src/game/wallet/connector', async (orig) => ({
  ...(await orig<typeof import('../src/game/wallet/connector')>()),
  walletFor: vi.fn(async () => ({
    manifest: { id: 'meteor-wallet', name: 'Meteor Wallet' },
    signAndSendTransaction: vi.fn(async (tx: unknown) => {
      if (reject) throw new Error('User rejected the request')
      sent.push(tx)
      return { transaction: { hash: 'DepositTxHash1' }, status: { SuccessValue: '' }, receipts_outcome: [] }
    }),
  })),
}))

const { ownerDeposit } = await import('../src/game/nearOwner')
const CONTRACT = 'ring.titleshot.testnet'
const NEAR = 10n ** 24n
const wallet: StoredAccount = { accountId: 'alice.testnet', fullKey: '', sessionKey: 'ed25519:x', createdAt: 1, kind: 'wallet', walletId: 'meteor-wallet' }
const guest: StoredAccount = { accountId: 'qa-1.play.titleshot.testnet', fullKey: 'ed25519:y', sessionKey: 'ed25519:x', createdAt: 1, kind: 'guest' }

describe('ownerDeposit (Add fight money)', () => {
  beforeEach(() => { sent.length = 0; reject = false })
  it('a wallet account sends exactly one `deposit` to the contract with the amount attached, signed as itself', async () => {
    await expect(ownerDeposit(CONTRACT, wallet, NEAR / 5n)).resolves.toBe('DepositTxHash1')
    expect(sent).toEqual([{ signerId: 'alice.testnet', network: 'testnet', receiverId: CONTRACT, actions: [{ type: 'FunctionCall', params: { methodName: 'deposit', args: {}, gas: '30000000000000', deposit: (NEAR / 5n).toString() } }] }])
  })
  it('a declined approval is a readable error and nothing is sent', async () => {
    reject = true
    await expect(ownerDeposit(CONTRACT, wallet, NEAR / 10n)).rejects.toMatchObject({ code: 'E_WALLET_REJECTED', message: 'You declined the deposit in your wallet. Nothing was sent.' })
    expect(sent).toEqual([])
  })
  it('a judge demo account cannot top up and is told how to keep playing; a zero amount and no account are refused', async () => {
    await expect(ownerDeposit(CONTRACT, guest, NEAR)).rejects.toMatchObject({ code: 'E_DEMO_TOPUP', message: expect.stringContaining('Move it to your wallet') })
    await expect(ownerDeposit(CONTRACT, wallet, 0n)).rejects.toMatchObject({ code: 'E_AMOUNT' })
    await expect(ownerDeposit(CONTRACT, null, NEAR)).rejects.toMatchObject({ code: 'E_NO_ACCOUNT' })
    expect(sent).toEqual([])
  })
})
