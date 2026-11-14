import { describe, expect, it, vi } from 'vitest'
import type { NearWalletBase } from '@hot-labs/near-connect'
import { Rpc } from '../src/game/chain/rpc'
import { toB64 } from '../src/game/chain/bytes'
import type { KeyStore } from '../src/game/nearKeys'
import { prepareSetup, setupWallet } from '../src/game/wallet/setup'
import { proveControl, type NonceRes } from '../src/game/wallet/prove'

// Web wallets (Meteor Web, MyNearWallet) open their sign tab with window.open, which browsers block unless it runs within
// ~5 s of the user's tap. So a tap must reach the wallet before any network round trip: these tests pin that order.
const NEAR = 10n ** 24n
const CONTRACT = 'ring.titleshot.testnet'
const ME = 'alice.testnet'

function memStore(): KeyStore {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, remove: (k) => { m.delete(k) } }
}

/** A fake RPC that logs every request into `events` and knows which access keys exist. */
function chain(events: string[]) {
  const keys = new Map<string, unknown>()
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const { params, id } = JSON.parse(String(init.body))
    events.push(`rpc:${params.request_type}`)
    const p = keys.get(`${params.account_id}|${params.public_key}`)
    const body = p ? { jsonrpc: '2.0', id, result: { nonce: 1, permission: p } } : { jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' }, message: 'UNKNOWN_ACCESS_KEY', data: 'UNKNOWN_ACCESS_KEY' } }
    return new Response(JSON.stringify(body))
  }) as unknown as typeof fetch
  return { rpc: new Rpc({ urls: ['http://rpc'], fetchFn }), keys }
}

describe('a wallet tap reaches the wallet before any network request', () => {
  it('setup: with prepareSetup read beforehand, the Approve tap calls the wallet first; the RPC is only read afterwards', async () => {
    const events: string[] = []
    const c = chain(events)
    const store = memStore()
    const prep = await prepareSetup(ME, CONTRACT, store, c.rpc)
    expect(prep).toEqual({ keyOnChain: false })
    events.length = 0 // the tap starts here
    const wallet = {
      manifest: { id: 'meteor-wallet', name: 'Meteor Wallet', features: { signAndSendTransactions: true } },
      signAndSendTransactions: vi.fn(async ({ transactions }: { transactions: { receiverId: string; actions: { type: string; params: any }[] }[] }) => {
        events.push('wallet')
        for (const t of transactions) for (const a of t.actions) if (a.type === 'AddKey') c.keys.set(`${t.receiverId}|${a.params.publicKey}`, { FunctionCall: { receiver_id: CONTRACT, method_names: ['challenge'], allowance: '1' } })
        return transactions.map((_, n) => ({ transaction: { hash: `h${n}` }, status: { SuccessValue: '' }, receipts_outcome: [] }))
      }),
    } as unknown as NearWalletBase
    await setupWallet({ wallet, accountId: ME, walletId: 'meteor-wallet', contract: CONTRACT, deposit: NEAR / 5n, store, rpc: c.rpc, sleep: async () => undefined, keyOnChain: prep.keyOnChain })
    // the wallet's successful AddKey outcome proves the key is on chain: no polling afterwards either (a slow RPC once held
    // the page on "Checking the chain…" for ~3 minutes after both transactions had landed)
    expect(events).toEqual(['wallet'])
  })

  it('setup without a prepared read still works (it reads the chain first, as before)', async () => {
    const events: string[] = []
    const c = chain(events)
    const wallet = {
      manifest: { id: 'x', name: 'X', features: { signAndSendTransactions: true } },
      signAndSendTransactions: vi.fn(async ({ transactions }: { transactions: { receiverId: string; actions: { type: string; params: any }[] }[] }) => {
        events.push('wallet')
        for (const t of transactions) for (const a of t.actions) if (a.type === 'AddKey') c.keys.set(`${t.receiverId}|${a.params.publicKey}`, { FunctionCall: { receiver_id: CONTRACT, method_names: ['challenge'], allowance: '1' } })
        return transactions.map((_, n) => ({ transaction: { hash: `h${n}` }, status: { SuccessValue: '' }, receipts_outcome: [] }))
      }),
    } as unknown as NearWalletBase
    await setupWallet({ wallet, accountId: ME, walletId: 'x', contract: CONTRACT, deposit: NEAR / 5n, store: memStore(), rpc: c.rpc, sleep: async () => undefined })
    expect(events[0]).toBe('rpc:view_access_key')
    expect(events).toContain('wallet')
  })

  it('Move to my wallet: with a nonce fetched beforehand, the Sign tap calls signMessage first; only verify goes to the server after', async () => {
    const events: string[] = []
    const fetchFn = (async (path: string) => {
      events.push(`fetch:${path}`)
      return new Response(JSON.stringify(path.endsWith('/verify') ? { ok: true, accountId: ME, publicKey: 'ed25519:k' } : { nonce: toB64(new Uint8Array(32)), message: 'm', recipient: 'title-shot.pages.dev', expiresAt: Date.now() + 300_000 }))
    }) as unknown as typeof fetch
    const pre: NonceRes = { nonce: toB64(new Uint8Array(32).fill(7)), message: 'Title Shot: I control alice.testnet.', recipient: 'title-shot.pages.dev', expiresAt: Date.now() + 300_000 }
    const wallet = {
      manifest: { id: 'meteor-wallet', name: 'Meteor Wallet', features: { signMessage: true } },
      signMessage: vi.fn(async () => { events.push('wallet'); return { accountId: ME, publicKey: 'ed25519:k', signature: toB64(new Uint8Array(64)) } }),
    } as unknown as NearWalletBase
    const r = await proveControl(wallet, ME, 'g1.play.titleshot.testnet', fetchFn, undefined, pre)
    expect(r.accountId).toBe(ME)
    expect(events).toEqual(['wallet', 'fetch:/api/auth/verify'])
  })

  it('an expired prefetched nonce is replaced by a fresh one rather than sent to the wallet', async () => {
    const events: string[] = []
    const fetchFn = (async (path: string) => {
      events.push(`fetch:${path}`)
      return new Response(JSON.stringify(path.endsWith('/verify') ? { ok: true, accountId: ME, publicKey: 'ed25519:k' } : { nonce: toB64(new Uint8Array(32)), message: 'm', recipient: 'title-shot.pages.dev', expiresAt: Date.now() + 300_000 }))
    }) as unknown as typeof fetch
    const wallet = { manifest: { id: 'w', name: 'W', features: { signMessage: true } }, signMessage: vi.fn(async () => { events.push('wallet'); return { accountId: ME, publicKey: 'ed25519:k', signature: toB64(new Uint8Array(64)) } }) } as unknown as NearWalletBase
    await proveControl(wallet, ME, 'g1', fetchFn, undefined, { nonce: 'x', message: 'm', recipient: 'r', expiresAt: Date.now() - 1 })
    expect(events).toEqual(['fetch:/api/auth/nonce', 'wallet', 'fetch:/api/auth/verify'])
  })
})
