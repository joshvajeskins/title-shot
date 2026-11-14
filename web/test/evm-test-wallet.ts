// A scripted EIP-1193 wallet backed by a real secp256k1 key (viem), for the payout wallet flow's tests. The same module is
// bundled into the browser init script for the live check (it announces itself through EIP-6963 there).
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Hex } from 'viem'

export interface TestWalletOptions {
  keys: Hex[]
  /** chain the wallet starts on (default Ethereum, 1) */
  chainId?: number
  /** chains it knows without wallet_addEthereumChain (default 1 and 11155111) */
  known?: number[]
  reject?: { connect?: boolean; switch?: boolean; add?: boolean; sign?: boolean }
  /** wallet_switchEthereumChain is not implemented (4200) */
  noSwitch?: boolean
  /** report an unknown chain the MetaMask-mobile way: -32603 wrapping 4902 */
  wrapUnknown?: boolean
  /** wallet_addEthereumChain adds without switching (the dapp must switch again) */
  addWithoutSwitch?: boolean
  /** switch "succeeds" but the wallet stays where it was */
  switchIsNoop?: boolean
  /** eth_requestAccounts answers [] */
  noAccounts?: boolean
  /** an open request already (every call fails with -32002) */
  pending?: boolean
  /** sign with this key instead of the connected one (a broken or smart-contract wallet) */
  signWith?: Hex
  /** called while a personal_sign prompt is "open"; return false to leave it open forever */
  duringSign?: (w: TestWallet) => boolean | void
}

export class RpcErr extends Error {
  code: number
  data?: unknown
  constructor(code: number, message: string, data?: unknown) { super(message); this.code = code; this.data = data }
}

type Listener = (...args: unknown[]) => void

export class TestWallet {
  calls: { method: string; params?: unknown }[] = []
  chainId: number
  known: Set<number>
  accounts: PrivateKeyAccount[]
  active = 0
  connected = false
  private listeners = new Map<string, Set<Listener>>()
  constructor(public o: TestWalletOptions) {
    this.accounts = o.keys.map((k) => privateKeyToAccount(k))
    this.chainId = o.chainId ?? 1
    this.known = new Set(o.known ?? [1, 11155111])
  }
  get address(): string { return this.accounts[this.active]!.address }
  on(event: string, l: Listener) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(l) }
  removeListener(event: string, l: Listener) { this.listeners.get(event)?.delete(l) }
  listenerCount(event: string) { return this.listeners.get(event)?.size ?? 0 }
  emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.forEach((l) => l(...args)) }
  /** the user picks another account in the wallet */
  switchAccount(i: number) { this.active = i; if (this.connected) this.emit('accountsChanged', [this.address]) }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.push({ method, params })
    const o = this.o
    if (o.pending && method !== 'eth_chainId') throw new RpcErr(-32002, 'Request already pending')
    switch (method) {
      case 'eth_chainId': return '0x' + this.chainId.toString(16)
      case 'eth_accounts': return this.connected ? [this.address] : []
      case 'eth_requestAccounts':
        if (o.reject?.connect) throw new RpcErr(4001, 'User rejected the request.')
        if (o.noAccounts) return []
        this.connected = true
        return [this.address]
      case 'wallet_switchEthereumChain': {
        if (o.noSwitch) throw new RpcErr(4200, 'Unsupported method')
        if (o.reject?.switch) throw new RpcErr(4001, 'User rejected the request.')
        const id = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16)
        if (!this.known.has(id)) throw o.wrapUnknown ? new RpcErr(-32603, 'Internal error', { originalError: { code: 4902 } }) : new RpcErr(4902, `Unrecognized chain ID "${id}".`)
        if (!o.switchIsNoop) { this.chainId = id; this.emit('chainChanged', '0x' + id.toString(16)) }
        return null
      }
      case 'wallet_addEthereumChain': {
        if (o.reject?.add) throw new RpcErr(4001, 'User rejected the request.')
        const id = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16)
        this.known.add(id)
        if (!o.addWithoutSwitch) this.chainId = id
        return null
      }
      case 'personal_sign': {
        const [data, from] = params as [Hex, string]
        if (from.toLowerCase() !== this.address.toLowerCase()) throw new RpcErr(4100, 'Unauthorized: not the connected account')
        if (o.reject?.sign) throw new RpcErr(4001, 'User denied message signature.')
        if (o.duringSign?.(this) === false) return new Promise(() => undefined)
        const signer = o.signWith ? privateKeyToAccount(o.signWith) : this.accounts[this.active]!
        return signer.signMessage({ message: { raw: data } })
      }
      case 'wallet_revokePermissions': this.connected = false; return null
      default: throw new RpcErr(4200, `Unsupported method ${method}`)
    }
  }
}

/** A minimal event host for EIP-6963 tests (a window stand-in). */
export class Host extends EventTarget { ethereum?: unknown }

/** Announce `wallet` on `host` now and whenever the page asks again (what a wallet extension's content script does). */
export function announce(host: EventTarget, info: { uuid: string; name: string; icon: string; rdns: string }, provider: unknown): void {
  const send = () => host.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  host.addEventListener('eip6963:requestProvider', send)
  send()
}
