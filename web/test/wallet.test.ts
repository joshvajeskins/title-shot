// NEAR wallet accounts (NEAR Connect): the one-approval setup, the stored session, network refusals and the owner-call routing.
import { describe, expect, it, vi } from 'vitest'
import type { NearWalletBase } from '@hot-labs/near-connect'
import { Rpc } from '../src/game/chain/rpc'
import { formatPublicKey, formatSecretKey, generateKeyPair } from '../src/game/chain/keys'
import { b58encode } from '../src/game/chain/base58'
import { toB64, utf8 } from '../src/game/chain/bytes'
import { ACCOUNT_KEY, activateWallet, exportKey, loadStored, saveStored, newGuestKeys, type KeyStore } from '../src/game/nearKeys'
import { NearClient } from '../src/game/near'
import { sessionSendError } from '../src/game/nearOwner'
import { assertTestnetAccount, isRejection } from '../src/game/wallet/connector'
import { SESSION_ALLOWANCE, setupTransactions, setupWallet } from '../src/game/wallet/setup'
import { signatureB64 } from '../src/game/wallet/prove'

const NEAR = 10n ** 24n
const CONTRACT = 'ring.titleshot.testnet'
const ME = 'alice.testnet'

function memStore(): KeyStore & { m: Map<string, string> } {
  const m = new Map<string, string>()
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, remove: (k) => { m.delete(k) } }
}

/** A fake RPC: accounts that exist, and access keys (publicKey -> permission) added as the wallet "sends". */
function chain(opts: { accounts?: string[]; balance?: Record<string, string> } = {}) {
  const keys = new Map<string, unknown>()
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
    const err = (name: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name }, message: name, data: name } }))
    if (method === 'query' && params.request_type === 'view_account') return (opts.accounts ?? [ME]).includes(params.account_id) ? ok({ amount: String(5n * NEAR), storage_usage: 500 }) : err('UNKNOWN_ACCOUNT')
    if (method === 'query' && params.request_type === 'view_access_key') {
      const p = keys.get(`${params.account_id}|${params.public_key}`)
      return p ? ok({ nonce: 1, permission: p }) : err('UNKNOWN_ACCESS_KEY')
    }
    if (method === 'query' && params.request_type === 'call_function') return ok({ result: Array.from(utf8(JSON.stringify(opts.balance?.[JSON.parse(atob(params.args_base64)).account] ?? '0'))), logs: [] })
    return err('UNKNOWN_METHOD')
  }) as unknown as typeof fetch
  return { rpc: new Rpc({ urls: ['http://rpc'], fetchFn }), fetchFn, keys }
}

const outcome = (hash: string, failure = false) => ({ transaction: { hash }, status: failure ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_STORAGE' } } } } } : { SuccessValue: '' }, receipts_outcome: [] })

/** A NEAR Connect wallet double. `onBatch` sees exactly what the person is asked to approve. */
function fakeWallet(c: ReturnType<typeof chain>, opts: { reject?: boolean; batch?: boolean } = {}) {
  const batches: { receiverId: string; actions: any[] }[][] = []
  const apply = (tx: { receiverId: string; actions: any[] }) => {
    for (const a of tx.actions) if (a.type === 'AddKey') c.keys.set(`${tx.receiverId}|${a.params.publicKey}`, { FunctionCall: { receiver_id: a.params.accessKey.permission.receiverId, method_names: a.params.accessKey.permission.methodNames, allowance: a.params.accessKey.permission.allowance } })
  }
  const wallet = {
    manifest: { id: 'fake', name: 'Fake Wallet', features: { signAndSendTransactions: opts.batch !== false } },
    signAndSendTransactions: vi.fn(async ({ transactions }: { transactions: any[] }) => {
      batches.push(transactions)
      if (opts.reject) throw new Error('User rejected the request')
      transactions.forEach(apply)
      return transactions.map((_, n) => outcome(`hash${n}`))
    }),
    signAndSendTransaction: vi.fn(async (tx: any) => {
      batches.push([tx])
      if (opts.reject) throw new Error('User rejected the request')
      apply(tx)
      return outcome(`single${batches.length}`)
    }),
  } as unknown as NearWalletBase
  return { wallet, batches }
}

describe('wallet setup: one approval adds the challenge-only session key and deposits the fight money', () => {
  it('builds AddKey (receiver = contract, method challenge, 0.25 NEAR allowance) on the account, then deposit on the contract', () => {
    const txs = setupTransactions(ME, 'ed25519:abc', CONTRACT, NEAR / 5n, false)
    expect(txs).toHaveLength(2)
    expect(txs[0]).toEqual({ receiverId: ME, actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:abc', accessKey: { permission: { receiverId: CONTRACT, allowance: SESSION_ALLOWANCE.toString(), methodNames: ['challenge'] } } } }] })
    expect(txs[1]).toEqual({ receiverId: CONTRACT, actions: [{ type: 'FunctionCall', params: { methodName: 'deposit', args: {}, gas: '30000000000000', deposit: String(NEAR / 5n) } }] })
    expect(setupTransactions(ME, 'ed25519:abc', CONTRACT, 0n, false)).toHaveLength(1)
    expect(setupTransactions(ME, 'ed25519:abc', CONTRACT, NEAR, true).map((t) => t.receiverId)).toEqual([CONTRACT])
  })

  it('asks the wallet ONCE (signAndSendTransactions), then stores the wallet account with only its session key', async () => {
    const c = chain()
    const { wallet, batches } = fakeWallet(c)
    const store = memStore()
    const r = await setupWallet({ wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: NEAR / 5n, store, rpc: c.rpc, sleep: async () => undefined })
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((t) => t.actions[0].type)).toEqual(['AddKey', 'FunctionCall'])
    expect(r.receipts.map((x) => x.label)).toEqual(['session key added', 'fight money deposited'])
    expect(r.receipts[0]!.url).toBe('https://testnet.nearblocks.io/txns/hash0')
    const st = loadStored(store)!
    expect(st).toMatchObject({ accountId: ME, kind: 'wallet', fullKey: '', walletId: 'fake' })
    expect(formatPublicKey(generateKeyPair().publicKey)).not.toBe(batches[0]![0]!.actions[0].params.publicKey)
    expect(store.m.has('ts-wallet-pending')).toBe(false)
    expect(exportKey(store)).toBeNull() // nothing to back up: the full-access key stays in the wallet
  })

  it('falls back to one transaction at a time when the wallet cannot batch', async () => {
    const c = chain()
    const { wallet, batches } = fakeWallet(c, { batch: false })
    await setupWallet({ wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: NEAR / 10n, store: memStore(), rpc: c.rpc, sleep: async () => undefined })
    expect(batches.map((b) => b.length)).toEqual([1, 1])
  })

  it('a declined approval stores nothing, says so, and a retry reuses the same session key', async () => {
    const c = chain()
    const store = memStore()
    const first = fakeWallet(c, { reject: true })
    await expect(setupWallet({ wallet: first.wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: NEAR / 5n, store, rpc: c.rpc, sleep: async () => undefined }))
      .rejects.toMatchObject({ code: 'E_WALLET_REJECTED', message: expect.stringMatching(/declined/) })
    expect(store.m.has(ACCOUNT_KEY)).toBe(false)
    const keyAsked = first.batches[0]![0]!.actions[0].params.publicKey
    const second = fakeWallet(c)
    await setupWallet({ wallet: second.wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: NEAR / 5n, store, rpc: c.rpc, sleep: async () => undefined })
    expect(second.batches[0]![0]!.actions[0].params.publicKey).toBe(keyAsked)
  })

  it('a session key already on chain (setup interrupted after approval) is not added twice', async () => {
    const c = chain()
    const store = memStore()
    const first = fakeWallet(c)
    vi.spyOn(first.wallet, 'signAndSendTransactions').mockImplementationOnce(async ({ transactions }: any) => {
      first.batches.push(transactions)
      c.keys.set(`${ME}|${transactions[0].actions[0].params.publicKey}`, { FunctionCall: { receiver_id: CONTRACT, method_names: ['challenge'] } })
      throw new Error('network dropped after the wallet sent it')
    })
    await expect(setupWallet({ wallet: first.wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: NEAR / 5n, store, rpc: c.rpc, sleep: async () => undefined })).rejects.toMatchObject({ code: 'E_WALLET' })
    const again = fakeWallet(c)
    await setupWallet({ wallet: again.wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: 0n, store, rpc: c.rpc, sleep: async () => undefined })
    expect(again.batches).toHaveLength(0)
    expect(loadStored(store)?.kind).toBe('wallet')
  })

  it('a failed deposit receipt is a readable contract error, and the account is not activated', async () => {
    const c = chain()
    const store = memStore()
    const { wallet } = fakeWallet(c)
    vi.spyOn(wallet, 'signAndSendTransactions').mockImplementationOnce(async () => [outcome('a'), outcome('b', true)] as any)
    await expect(setupWallet({ wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: NEAR / 5n, store, rpc: c.rpc, sleep: async () => undefined })).rejects.toMatchObject({ code: 'E_STORAGE' })
    expect(store.m.has(ACCOUNT_KEY)).toBe(false)
  })

  it('refuses a deposit below the 0.005 NEAR storage minimum before asking the wallet', async () => {
    const c = chain()
    const { wallet, batches } = fakeWallet(c)
    await expect(setupWallet({ wallet, accountId: ME, walletId: 'fake', contract: CONTRACT, deposit: 1000n, store: memStore(), rpc: c.rpc })).rejects.toMatchObject({ code: 'E_AMOUNT' })
    expect(batches).toHaveLength(0)
  })
})

describe('network: a mainnet account or the wrong network is refused clearly', () => {
  it('refuses .near names and names outside testnet', async () => {
    const c = chain()
    await expect(assertTestnetAccount('alice.near', c.rpc)).rejects.toMatchObject({ code: 'E_WRONG_NETWORK', message: expect.stringMatching(/mainnet account.*testnet/) })
    await expect(assertTestnetAccount('alice.tg', c.rpc)).rejects.toMatchObject({ code: 'E_WRONG_NETWORK' })
  })
  it('refuses a testnet-looking or implicit account that does not exist on testnet', async () => {
    const c = chain({ accounts: [] })
    await expect(assertTestnetAccount('ghost.testnet', c.rpc)).rejects.toMatchObject({ code: 'E_WRONG_NETWORK', message: expect.stringMatching(/does not exist on NEAR testnet/) })
    await expect(assertTestnetAccount('a'.repeat(64), c.rpc)).rejects.toMatchObject({ code: 'E_WRONG_NETWORK' })
  })
  it('accepts an existing .testnet account', async () => {
    await expect(assertTestnetAccount(ME, chain().rpc)).resolves.toBeUndefined()
  })
  it('recognises the ways wallets say "declined"', () => {
    for (const m of ['User rejected the request', 'User cancelled', 'Wallet closed', 'Request denied']) expect(isRejection(new Error(m)), m).toBe(true)
    expect(isRejection(new Error('Exceeded the prepaid gas'))).toBe(false)
  })
})

describe('stored wallet account and the client', () => {
  it('activating a wallet archives the guest it replaces; the client reports kind wallet and its game balance', async () => {
    const store = memStore()
    const guestKeys = newGuestKeys()
    saveStored(store, guestKeys, 'brave-otter-01.play.titleshot.testnet')
    activateWallet(store, { accountId: ME, sessionKey: formatSecretKey(generateKeyPair()), walletId: 'meteor-wallet' })
    expect(JSON.parse(store.m.get('ts-account-archive')!)[0].accountId).toBe('brave-otter-01.play.titleshot.testnet')
    const c = chain({ balance: { [ME]: String(NEAR / 5n) } })
    const client = new NearClient({ contractId: CONTRACT, fetchFn: c.fetchFn, store, rpcUrls: ['http://rpc'] })
    expect(await client.account()).toEqual({ id: ME, kind: 'wallet', balanceYocto: String(NEAR / 5n), claimableYocto: '0' })
  })
  it('a wallet record with a full key in it, or without a session key, is not a valid account', () => {
    const store = memStore()
    store.set(ACCOUNT_KEY, JSON.stringify({ accountId: ME, fullKey: 'ed25519:x', sessionKey: 'ed25519:y', createdAt: 1, kind: 'wallet' }))
    expect(loadStored(store)).toBeNull()
    store.set(ACCOUNT_KEY, JSON.stringify({ accountId: ME, fullKey: '', sessionKey: '', createdAt: 1, kind: 'wallet' }))
    expect(loadStored(store)).toBeNull()
  })
  it('signing out a wallet account does not archive it (its keys live in the wallet)', async () => {
    const store = memStore()
    activateWallet(store, { accountId: ME, sessionKey: formatSecretKey(generateKeyPair()), walletId: 'x' })
    await new NearClient({ contractId: CONTRACT, store, fetchFn: chain().fetchFn }).signOut()
    expect(loadStored(store)).toBeNull()
    expect(store.m.get('ts-account-archive') ?? '[]').toBe('[]')
  })
  it('session-key errors give wallet accounts wallet advice and guests the old guest advice', () => {
    expect(sessionSendError(new Error('NotEnoughAllowance'), true).message).toMatch(/connect your wallet again/)
    expect(sessionSendError(new Error('NotEnoughAllowance'), false).message).toBe('This guest corner has used up its gas allowance. Create a new guest corner to keep fighting.')
  })
})

describe('NEP-413 signatures from wallets are normalised to base64', () => {
  it('keeps base64, converts base58 and ed25519:<base58>', () => {
    const sig = new Uint8Array(64).map((_, i) => (i * 7) % 256)
    expect(signatureB64(toB64(sig))).toBe(toB64(sig))
    expect(signatureB64(b58encode(sig))).toBe(toB64(sig))
    expect(signatureB64('ed25519:' + b58encode(sig))).toBe(toB64(sig))
  })
})
