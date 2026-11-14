// Ethereum-address NEAR accounts (NEAR Connect's "Ethereum Wallets"): the browser proves control with EIP-191 through an
// EIP-6963 wallet in the page, against the real /api/auth handlers.
import { describe, expect, it } from 'vitest'
import type { NearWalletBase } from '@hot-labs/near-connect'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hexToString } from 'viem'
import { ctx, env } from './helpers'
import { onRequest as nonceApi } from '../functions/api/auth/nonce'
import { onRequest as verifyApi } from '../functions/api/auth/verify'
import { proveControl } from '../src/game/wallet/prove'
import { evmProviderFor, isEvmAccount } from '../src/game/wallet/proveEvm'
import type { WalletHost } from '../src/game/evm/discover'

const HOST = 'https://title-shot.pages.dev'

/** fetch routed to the real Pages Functions handlers, sharing one KV. */
function server() {
  const e = env()
  const fetchFn = (async (path: string, init: RequestInit) => {
    const req = new Request(HOST + path, { ...init, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' } })
    return (path.endsWith('/nonce') ? nonceApi : verifyApi)(ctx(req, e))
  }) as unknown as typeof fetch
  return { fetchFn }
}

/** A page with one EIP-6963 wallet backed by a fresh viem key. */
function page(opts: { reject?: boolean } = {}) {
  const acct = privateKeyToAccount(generatePrivateKey())
  const signed: string[] = []
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [acct.address]
      if (method === 'personal_sign') {
        if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
        const hex = (params as string[])[0] as `0x${string}`
        signed.push(hexToString(hex))
        return acct.signMessage({ message: { raw: hex } })
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  const target = new EventTarget()
  target.addEventListener('eip6963:requestProvider', () => {
    target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail: { info: { uuid: 'u-1', name: 'Test EVM', icon: '', rdns: 'test.evm' }, provider } }))
  })
  const host = target as unknown as WalletHost
  return { host, address: acct.address.toLowerCase(), signed }
}

const nearWallet = (signMessage: boolean) => ({ manifest: { id: 'w', name: 'Some Wallet', features: { signMessage } }, signMessage: async () => { throw new Error('not used') } }) as unknown as NearWalletBase

describe('Move to my wallet, Ethereum-address target: EIP-191 through EIP-6963', () => {
  it('a 0x account proves control with personal_sign; the server binds domain and nonce in the signed text', async () => {
    const p = page()
    const { fetchFn } = server()
    const r = await proveControl(nearWallet(false), p.address, 'brave-otter-01.play.titleshot.testnet', fetchFn, p.host)
    expect(r.accountId).toBe(p.address)
    expect(p.signed[0]).toMatch(/^Title Shot: I control 0x[0-9a-f]{40}/)
    expect(p.signed[0]).toContain('\nDomain: title-shot.pages.dev\nNonce: ')
  })
  it('a declined signature is a clean, readable refusal', async () => {
    const p = page({ reject: true })
    await expect(proveControl(nearWallet(false), p.address, 'g.play.titleshot.testnet', server().fetchFn, p.host)).rejects.toMatchObject({ code: 'E_WALLET_REJECTED' })
  })
  it('no injected wallet holds the address: says where to open the page', async () => {
    const p = page()
    await expect(evmProviderFor('0x' + '1'.repeat(40), p.host)).rejects.toMatchObject({ code: 'E_NO_EVM', message: expect.stringMatching(/None of this browser's Ethereum wallets/) })
    const empty = new EventTarget() as unknown as WalletHost
    await expect(evmProviderFor('0x' + '1'.repeat(40), empty)).rejects.toMatchObject({ code: 'E_NO_EVM', message: expect.stringMatching(/WalletConnect/) })
  })
  it('a named NEAR account on a wallet without signMessage is refused before anything is asked', async () => {
    await expect(proveControl(nearWallet(false), 'alice.testnet', 'g.play.titleshot.testnet', server().fetchFn)).rejects.toMatchObject({ code: 'E_WALLET', message: expect.stringMatching(/cannot sign the ownership message/) })
  })
  it('only lowercase 0x + 40 hex is an Ethereum-address account', () => {
    expect(isEvmAccount('0x' + 'a'.repeat(40))).toBe(true)
    expect(isEvmAccount('0x' + 'A'.repeat(40))).toBe(false)
    expect(isEvmAccount('alice.testnet')).toBe(false)
  })
})
