// The payout dialog's "connect a wallet" path without a browser: EIP-6963 discovery over a stand-in window, the Base Sepolia
// switch, the binding message and its signature check (real secp256k1 keys), and the whole flow against a scripted wallet.
import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getAddress, hexToString } from 'viem'
import { ANNOUNCE_EVENT, discoverWallets, LEGACY_UUID, legacyName, readAnnouncement, REQUEST_EVENT, safeIcon, watchWallets } from '../src/game/evm/discover'
import { BASE_SEPOLIA_HEX, BASE_SEPOLIA_ID, chainName, ensureBaseSepolia } from '../src/game/evm/chain'
import { bindingMessage, newNonce, personalSignParams, verifyBinding } from '../src/game/evm/proof'
import { linkWallet, type LinkStep } from '../src/game/evm/link'
import { errorCopy, stepCopy } from '../src/game/evm/copy'
import { chainIdOf, errorCode, WalletError, type WalletErrorKind, type WalletOption } from '../src/game/evm/types'
import { announce, Host, TestWallet } from './evm-test-wallet'

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+'
const ME = 'calm-heron-12.play.titleshot.testnet'
const DOMAIN = 'title-shot.pages.dev'
const NONCE = 'a3f1c2d4e5b60718293a4b5c6d7e8f90'
const keys = () => [generatePrivateKey(), generatePrivateKey()]

async function kindOf(p: Promise<unknown>): Promise<WalletErrorKind | 'resolved'> {
  try { await p; return 'resolved' } catch (e) { expect(e).toBeInstanceOf(WalletError); return (e as WalletError).kind }
}

describe('binding message and signature check', () => {
  const addr = privateKeyToAccount(generatePrivateKey()).address
  const b = { nearAccount: ME, address: addr.toLowerCase(), domain: DOMAIN, nonce: NONCE, issuedAt: '2026-11-14T16:00:00.000Z' }

  it('names the NEAR account, the checksummed address, the chain, the domain and the nonce, one per line', () => {
    const m = bindingMessage(b)
    expect(m.split('\n')).toEqual(expect.arrayContaining([
      `NEAR account: ${ME}`, `EVM address: ${getAddress(addr)}`, `Chain ID: ${BASE_SEPOLIA_ID}`, `Domain: ${DOMAIN}`, `Nonce: ${NONCE}`, 'Issued at: 2026-11-14T16:00:00.000Z',
    ]))
    expect(m.startsWith(`${DOMAIN} asks you to link this wallet`)).toBe(true)
    expect(m).toContain('sends no transaction')
    expect(m.length).toBeLessThan(700)
  })

  it('refuses input that should never reach a wallet', () => {
    expect(() => bindingMessage({ ...b, nearAccount: 'Bad Account' })).toThrow(/NEAR account/)
    expect(() => bindingMessage({ ...b, nearAccount: 'evil\nNEAR account: someone.testnet' })).toThrow(/NEAR account/)
    expect(() => bindingMessage({ ...b, address: '0x1234' })).toThrow(/EVM address/)
    expect(() => bindingMessage({ ...b, nonce: 'short' })).toThrow(/nonce/)
    expect(() => bindingMessage({ ...b, domain: 'evil.com\nDomain: title-shot.pages.dev' })).toThrow(/domain/)
  })

  it('makes a fresh 128-bit nonce each time', () => {
    const n = new Set(Array.from({ length: 50 }, newNonce))
    expect(n.size).toBe(50)
    for (const x of n) expect(x).toMatch(/^[0-9a-f]{32}$/)
  })

  it('sends personal_sign the UTF-8 hex of the message, then the address', () => {
    const [data, from] = personalSignParams('hi ✓', addr)
    expect(hexToString(data)).toBe('hi ✓')
    expect(from).toBe(addr)
  })

  it('accepts only the signer, over exactly this message', async () => {
    const key = generatePrivateKey()
    const acct = privateKeyToAccount(key)
    const m = bindingMessage({ ...b, address: acct.address })
    const sig = await acct.signMessage({ message: m })
    expect(await verifyBinding(m, sig, acct.address)).toBe(true)
    expect(await verifyBinding(m, sig, acct.address.toLowerCase())).toBe(true)
    expect(await verifyBinding(m, sig, addr)).toBe(false) // someone else's address
    expect(await verifyBinding(m.replace(NONCE, newNonce()), sig, acct.address)).toBe(false) // another nonce
    expect(await verifyBinding(m.replace(ME, 'thief.testnet'), sig, acct.address)).toBe(false) // another NEAR account
    expect(await verifyBinding(m, '0xdeadbeef', acct.address)).toBe(false)
    expect(await verifyBinding(m, 'not hex', acct.address)).toBe(false)
    expect(await verifyBinding(m, sig, 'nope')).toBe(false)
  })
})

describe('EIP-6963 discovery', () => {
  const info = (n: number, extra: Partial<WalletOption['info']> = {}) => ({ uuid: `uuid-${n}`, name: `Wallet ${n}`, icon: ICON, rdns: `io.wallet${n}`, ...extra })

  it('asks wallets to announce and lists each with its own name and icon', () => {
    const host = new Host()
    const p1 = new TestWallet({ keys: keys() })
    const p2 = new TestWallet({ keys: keys() })
    announce(host, info(1), p1)
    announce(host, info(2, { name: '  Rabby  ' }), p2)
    let seen: WalletOption[] = []
    const w = watchWallets(host, (l) => { seen = l })
    expect(seen.map((x) => x.info.name)).toEqual(['Wallet 1', 'Rabby'])
    expect(seen[0]!.info.icon).toBe(ICON)
    expect(seen[0]!.provider).toBe(p1)
    w.stop()
  })

  it('keeps the first wallet per uuid and per provider, and ignores malformed announcements', () => {
    const host = new Host()
    const p = new TestWallet({ keys: keys() })
    let seen: WalletOption[] = []
    const w = watchWallets(host, (l) => { seen = l })
    const send = (detail: unknown) => host.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail }))
    send({ info: info(1), provider: p })
    send({ info: info(1, { name: 'Impostor' }), provider: new TestWallet({ keys: keys() }) }) // same uuid
    send({ info: info(9), provider: p }) // same provider again
    send({ info: info(3), provider: {} }) // no request()
    send({ info: { name: 'No uuid' }, provider: p })
    send({ info: info(4, { name: '' }), provider: new TestWallet({ keys: keys() }) })
    send(null)
    expect(seen.map((x) => x.info.name)).toEqual(['Wallet 1'])
    w.stop()
  })

  it('drops icons that are not data-URI images, so no remote URL or script reaches an <img>', () => {
    expect(safeIcon(ICON)).toBe(ICON)
    expect(safeIcon('data:image/png;base64,iVBORw0KGgo=')).toMatch(/^data:image\/png/)
    for (const bad of ['https://tracker.example/icon.svg', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 42, undefined]) expect(safeIcon(bad)).toBe('')
    expect(readAnnouncement({ info: info(5, { icon: 'https://x.example/i.png' }), provider: new TestWallet({ keys: keys() }) })!.info.icon).toBe('')
  })

  it('lists wallets that load after the dialog opened, and stops listening on stop()', () => {
    const host = new Host()
    const updates: string[][] = []
    const w = watchWallets(host, (l) => updates.push(l.map((x) => x.info.name)))
    announce(host, info(7), new TestWallet({ keys: keys() }))
    expect(updates.at(-1)).toEqual(['Wallet 7'])
    w.stop()
    announce(host, info(8), new TestWallet({ keys: keys() }))
    expect(updates.at(-1)).toEqual(['Wallet 7'])
  })

  it('falls back to window.ethereum only when nothing announces', async () => {
    const host = new Host()
    const legacy = Object.assign(new TestWallet({ keys: keys() }), { isRabby: true })
    host.ethereum = legacy
    const alone = await discoverWallets(host, 10)
    expect(alone.map((x) => [x.info.uuid, x.info.name])).toEqual([[LEGACY_UUID, 'Rabby']])
    expect(alone[0]!.provider).toBe(legacy)
    announce(host, info(1), new TestWallet({ keys: keys() }))
    expect((await discoverWallets(host, 10)).map((x) => x.info.uuid)).toEqual(['uuid-1'])
    expect(await discoverWallets(new Host(), 10)).toEqual([])
    host.ethereum = { not: 'a provider' }
    expect(legacyName({ isMetaMask: true })).toBe('MetaMask')
    expect(legacyName({})).toBe('Browser wallet')
  })

  it('dispatches the request event each time it is asked', () => {
    const host = new Host()
    let asked = 0
    host.addEventListener(REQUEST_EVENT, () => { asked++ })
    const w = watchWallets(host, () => undefined)
    w.refresh()
    expect(asked).toBe(2)
    w.stop()
  })
})

describe('switching to Base Sepolia', () => {
  const methods = (w: TestWallet) => w.calls.map((c) => c.method)

  it('does nothing when the wallet is already there', async () => {
    const w = new TestWallet({ keys: keys(), chainId: BASE_SEPOLIA_ID })
    expect(await ensureBaseSepolia(w)).toBe(false)
    expect(methods(w)).toEqual(['eth_chainId'])
  })

  it('switches when the wallet knows the chain', async () => {
    const w = new TestWallet({ keys: keys(), known: [1, BASE_SEPOLIA_ID] })
    expect(await ensureBaseSepolia(w)).toBe(true)
    expect(w.calls[1]).toEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_HEX }] })
    expect(w.chainId).toBe(BASE_SEPOLIA_ID)
  })

  it('adds the chain on 4902 (and on the MetaMask-mobile wrapped form), with the right parameters', async () => {
    for (const wrapUnknown of [false, true]) {
      const w = new TestWallet({ keys: keys(), wrapUnknown })
      expect(await ensureBaseSepolia(w)).toBe(true)
      const add = w.calls.find((c) => c.method === 'wallet_addEthereumChain')!.params as [{ chainId: string; rpcUrls: string[]; nativeCurrency: { decimals: number } }]
      expect(add[0].chainId).toBe('0x14a34')
      expect(add[0].rpcUrls[0]).toBe('https://sepolia.base.org')
      expect(add[0].nativeCurrency.decimals).toBe(18)
      expect(w.chainId).toBe(BASE_SEPOLIA_ID)
    }
  })

  it('switches again when adding did not switch', async () => {
    const w = new TestWallet({ keys: keys(), addWithoutSwitch: true })
    expect(await ensureBaseSepolia(w)).toBe(true)
    expect(methods(w).filter((m) => m === 'wallet_switchEthereumChain')).toHaveLength(2)
    expect(w.chainId).toBe(BASE_SEPOLIA_ID)
  })

  it('reports a refused switch or add as chain-refused, with the chain the wallet stayed on', async () => {
    for (const reject of [{ switch: true }, { add: true }]) {
      const w = new TestWallet({ keys: keys(), chainId: 1, reject })
      const e = await ensureBaseSepolia(w).catch((x: WalletError) => x)
      expect(e).toBeInstanceOf(WalletError)
      expect((e as WalletError).kind).toBe('chain-refused')
      expect((e as WalletError).detail.chainId).toBe(1)
    }
  })

  it('reports a wallet that cannot switch, or that stays put, as wrong-chain', async () => {
    expect(await kindOf(ensureBaseSepolia(new TestWallet({ keys: keys(), noSwitch: true })))).toBe('wrong-chain')
    const stuck = new TestWallet({ keys: keys(), known: [1, BASE_SEPOLIA_ID], switchIsNoop: true })
    const e = await ensureBaseSepolia(stuck).catch((x: WalletError) => x)
    expect((e as WalletError).kind).toBe('wrong-chain')
    expect((e as WalletError).detail.chainId).toBe(1)
  })

  it('reads chain ids and wrapped error codes the ways wallets send them', () => {
    expect(chainIdOf('0x14a34')).toBe(84532)
    expect(chainIdOf(84532)).toBe(84532)
    expect(chainIdOf('84532')).toBe(84532)
    expect(chainIdOf('base')).toBeUndefined()
    expect(errorCode({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(4902)
    expect(errorCode({ cause: { code: 4001 } })).toBe(4001)
    expect(errorCode('x')).toBeUndefined()
    expect(chainName(1)).toBe('Ethereum')
    expect(chainName(999999)).toBe('chain 999999')
  })
})

describe('linking a wallet', () => {
  const run = (w: TestWallet, extra: Partial<Parameters<typeof linkWallet>[0]> = {}) =>
    linkWallet({ provider: w, nearAccount: ME, domain: DOMAIN, nonce: NONCE, now: () => new Date('2026-11-14T16:00:00Z'), ...extra })

  it('connects, switches, signs and verifies, then hands back the lowercase address', async () => {
    const w = new TestWallet({ keys: keys() })
    const steps: LinkStep[] = []
    const r = await run(w, { onStep: (s) => steps.push(s) })
    expect(steps).toEqual(['connecting', 'switching', 'signing', 'verifying'])
    expect(r.address).toBe(w.address.toLowerCase())
    expect(r.switched).toBe(true)
    expect(r.message).toContain(`NEAR account: ${ME}`)
    expect(await verifyBinding(r.message, r.signature, r.address)).toBe(true)
    const sign = w.calls.find((c) => c.method === 'personal_sign')!.params as [string, string]
    expect(hexToString(sign[0] as `0x${string}`)).toBe(r.message)
    expect(w.listenerCount('accountsChanged')).toBe(0)
  })

  it('names each refusal by the step it happened at', async () => {
    expect(await kindOf(run(new TestWallet({ keys: keys(), reject: { connect: true } })))).toBe('rejected')
    expect(await kindOf(run(new TestWallet({ keys: keys(), reject: { switch: true } })))).toBe('chain-refused')
    expect(await kindOf(run(new TestWallet({ keys: keys(), reject: { sign: true } })))).toBe('sign-rejected')
    expect(await kindOf(run(new TestWallet({ keys: keys(), noAccounts: true })))).toBe('no-account')
    expect(await kindOf(run(new TestWallet({ keys: keys(), pending: true })))).toBe('pending')
  })

  it('never asks for a signature when the wallet would not switch', async () => {
    const w = new TestWallet({ keys: keys(), noSwitch: true })
    expect(await kindOf(run(w))).toBe('wrong-chain')
    expect(w.calls.some((c) => c.method === 'personal_sign')).toBe(false)
  })

  it('fails as account-changed when the wallet switches accounts while its sign prompt is open', async () => {
    const w = new TestWallet({ keys: keys(), duringSign: (x) => { x.switchAccount(1); return false } })
    const from = w.address.toLowerCase()
    const e = await run(w).catch((x: WalletError) => x)
    expect((e as WalletError).kind).toBe('account-changed')
    expect((e as WalletError).detail).toEqual({ from, to: w.accounts[1]!.address.toLowerCase() })
  })

  it('fails as account-changed when the wallet answers but has moved on by then', async () => {
    const w = new TestWallet({ keys: keys(), duringSign: (x) => { x.active = 1 } }) // no event: only eth_accounts tells
    expect(await kindOf(run(w))).toBe('account-changed')
  })

  it('rejects a signature from any other key', async () => {
    const w = new TestWallet({ keys: keys(), signWith: generatePrivateKey() })
    expect(await kindOf(run(w))).toBe('bad-signature')
  })

  it('stops at once when cancelled, even with a wallet prompt left open', async () => {
    const ctl = new AbortController()
    const w = new TestWallet({ keys: keys(), duringSign: () => { ctl.abort(); return false } })
    expect(await kindOf(run(w, { signal: ctl.signal }))).toBe('cancelled')
    expect(w.listenerCount('accountsChanged')).toBe(0)
  })

  it('has words for every step and every failure', () => {
    for (const s of ['connecting', 'switching', 'signing', 'verifying'] as const) expect(stepCopy(s, 'Rabby')).toBeTruthy()
    const kinds: WalletErrorKind[] = ['rejected', 'sign-rejected', 'chain-refused', 'wrong-chain', 'account-changed', 'no-account', 'pending', 'bad-signature', 'cancelled', 'failed']
    for (const k of kinds) {
      const c = errorCopy(new WalletError(k, 'The wallet said no.', { chainId: 1, from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40) }), 'Rabby')
      expect(c.title && c.body && c.retry).toBeTruthy()
    }
    expect(errorCopy(new WalletError('chain-refused', 'x', { chainId: 1 }), 'Rabby').title).toBe('Still on Ethereum')
    expect(errorCopy(new WalletError('account-changed', 'x', { from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40) }), 'Rabby').retry).toBe('Link 0x2222…2222')
  })
})
