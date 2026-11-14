// Basenames on Base Sepolia (`*.basetest.eth`): name -> address, address -> primary name, and the pure checks behind the
// payout dialog. Reads go through the shared failover Rpc (plain fetch); viem is used only for ABI encoding and namehash.
import { decodeFunctionResult, encodeFunctionData, namehash, parseAbi, zeroAddress, type Hex } from 'viem'
import { Rpc, RpcError } from './rpc'

/** Public Base Sepolia RPCs (the same list as the Pages Functions' DEFAULTS.baseRpcs). */
export const BASE_SEPOLIA_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com']

/**
 * Base Sepolia deployment from github.com/base/basenames (README). Checked on chain 2026-11-14: both the legacy and the
 * upgradeable controller are registrar controllers, but only the upgradeable controller is approved on the upgradeable
 * resolver, so new names register through it. Primary names stay on the legacy L2Resolver.
 */
export const BASENAMES = {
  parent: 'basetest.eth',
  registry: '0x1493b2567056c2181630115660963e13a8e32735',
  controller: '0x82c858cdf64b3d893fe54962680edfddc37e94c8', // UpgradeableRegistrarController (proxy)
  resolver: '0x85c87e548091f204c2d0350b39ce1874f02197c6', // UpgradeableL2Resolver (proxy): records of new names
  legacyResolver: '0x6533c94869d28faa8df77cc63f9e2b2d6cf77eba', // L2Resolver: primary (reverse) names live here
  reverseParent: '80014a34.reverse', // coin type 0x80000000 | 84532; equals ReverseRegistrar.reverseNode()
  l2ReverseRegistrar: '0x00000beef055f7934784d6d81b6bc86665630dba', // ENS's ENSIP-19 reverse registrar (fallback source)
} as const

/** Vance's Base Sepolia address: the Chain Signatures key of vance.titleshot.testnet, path "vance-purse" (scripts/live-check.mts). */
export const VANCE_BASE_ADDRESS = '0xedc7423225a2afc44375cf36feffc4119b484d49'
export const ONE_YEAR_SEC = 365n * 24n * 3600n

const ABI = parseAbi([
  'function resolver(bytes32 node) view returns (address)',
  'function addr(bytes32 node) view returns (address)',
  'function name(bytes32 node) view returns (string)',
  'function nameForAddr(address addr) view returns (string)',
  'function setAddr(bytes32 node, address a)',
  'function setText(bytes32 node, string key, string value)',
  'function available(string name) view returns (bool)',
  'function registerPrice(string name, uint256 duration) view returns (uint256)',
  'function register((string name, address owner, uint256 duration, address resolver, bytes[] data, bool reverseRecord, uint256[] coinTypes, uint256 signatureExpiry, bytes signature) request) payable',
])
type ReadFn = 'resolver' | 'addr' | 'name' | 'nameForAddr' | 'available' | 'registerPrice'

const HEX40 = /^0x[0-9a-fA-F]{40}$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const SUFFIX = `.${BASENAMES.parent}`

export type NameCheck = { ok: true; name: string; label: string } | { ok: false; reason: string }

/**
 * Normalise what someone typed into `label.basetest.eth`. ASCII only on purpose: a payout name must not be a unicode
 * look-alike of someone else's, so letters a-z, digits and hyphens (3 to 63 characters, the Basenames minimum is 3).
 */
export function checkBasename(input: string): NameCheck {
  const s = input.trim().toLowerCase().replace(/\.$/, '')
  if (!s) return { ok: false, reason: 'Enter a name.' }
  if (s.endsWith('.base.eth')) return { ok: false, reason: 'That is a Base mainnet name. On Base Sepolia, names end in .basetest.eth.' }
  const label = s.endsWith(SUFFIX) ? s.slice(0, -SUFFIX.length) : s
  if (label.includes('.')) return { ok: false, reason: 'Only Base Sepolia names resolve here: yourname.basetest.eth.' }
  if (/[^\x20-\x7e]/.test(label)) return { ok: false, reason: 'Use plain letters a-z, digits and hyphens. Look-alike unicode names are not accepted for payouts.' }
  if (label.length < 3) return { ok: false, reason: 'Basenames are at least 3 characters long.' }
  if (label.length > 63 || !LABEL.test(label) || label.slice(2, 4) === '--') {
    return { ok: false, reason: 'Letters a-z, digits and hyphens only, not starting or ending with a hyphen.' }
  }
  return { ok: true, name: label + SUFFIX, label }
}

// ---- the payout dialog's logic (pure, so it is tested without a DOM) ----

export type PayoutInput =
  | { kind: 'empty' }
  | { kind: 'address'; address: string }
  | { kind: 'name'; name: string }
  | { kind: 'invalid'; reason: string }

export function parsePayoutInput(raw: string): PayoutInput {
  const t = raw.trim()
  if (!t) return { kind: 'empty' }
  if (/^0x/i.test(t)) {
    if (!HEX40.test(t)) return { kind: 'invalid', reason: "That isn't an EVM address (0x followed by 40 hex characters)." }
    const address = t.toLowerCase()
    return address === zeroAddress ? { kind: 'invalid', reason: 'That is the zero address: a payout sent there is burned.' } : { kind: 'address', address }
  }
  const c = checkBasename(t)
  return c.ok ? { kind: 'name', name: c.name } : { kind: 'invalid', reason: c.reason }
}

/** Identity of an input, so a lookup answer is only ever applied to the input it was made for. */
export const inputKey = (p: PayoutInput): string => (p.kind === 'address' ? p.address : p.kind === 'name' ? p.name : '')

export type Lookup =
  | { state: 'idle' }
  | { state: 'resolving'; key: string }
  | { state: 'resolved'; key: string; address: string; name: string | null }
  | { state: 'failed'; key: string; reason: string }

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase()

/**
 * The address the dialog may save now, or null. A pasted address is final on its own (its name is decoration and may
 * still be loading). A name saves only once it resolved, for this exact input. Nothing saves when it is already on file.
 */
export function saveTarget(input: PayoutInput, lookup: Lookup, current: string | null): string | null {
  if (input.kind === 'address') return same(current, input.address) ? null : input.address
  if (input.kind !== 'name' || lookup.state !== 'resolved' || lookup.key !== input.name) return null
  return same(current, lookup.address) ? null : lookup.address
}

/** What the dialog shows before saving: a name's address, or an address's primary name (best effort). */
export async function resolvePayout(input: PayoutInput, bn: Basenames): Promise<Lookup> {
  if (input.kind === 'address') {
    const name = await bn.reverse(input.address).catch(() => null)
    return { state: 'resolved', key: input.address, address: input.address, name }
  }
  if (input.kind !== 'name') return { state: 'idle' }
  const key = input.name
  try {
    const r = await bn.lookup(input.name)
    if (r.status === 'ok') return { state: 'resolved', key, address: r.address, name: input.name }
    const reason = r.status === 'unregistered'
      ? `${input.name} is not registered on Base Sepolia.`
      : `${input.name} has no address set. Set one at base.org, or paste the 0x address.`
    return { state: 'failed', key, reason }
  } catch {
    return { state: 'failed', key, reason: "Couldn't reach Base Sepolia to look that name up. Try again, or paste the 0x address." }
  }
}

// ---- chain reads, cached briefly ----

export type NameLookup = { status: 'ok'; address: string } | { status: 'unregistered' } | { status: 'no-address' }

interface Entry { exp: number; value: Promise<unknown> }

export class Basenames {
  private cache = new Map<string, Entry>()
  constructor(
    private rpc: Rpc = new Rpc({ urls: BASE_SEPOLIA_RPCS, timeoutMs: 8000 }),
    private ttlMs = 30_000,
    private now: () => number = () => Date.now(),
  ) {}

  /** One cached promise per key; a failed (network) lookup is dropped at once so the next call retries. */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && hit.exp > this.now()) return hit.value as Promise<T>
    const value = load()
    this.cache.set(key, { exp: this.now() + this.ttlMs, value })
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key) })
    return value
  }

  /** eth_call; a revert or empty answer means "no such record" (null), an unreachable network throws. */
  private async read<T>(to: string, fn: ReadFn, args: readonly unknown[]): Promise<T | null> {
    const data = encodeFunctionData({ abi: ABI, functionName: fn, args } as never)
    let out: Hex
    try {
      out = await this.rpc.call<Hex>('eth_call', [{ to, data }, 'latest'])
    } catch (e) {
      if (e instanceof RpcError) return null
      throw e
    }
    if (!out || out === '0x') return null
    try { return decodeFunctionResult({ abi: ABI, functionName: fn, data: out } as never) as T } catch { return null }
  }

  private async resolverOf(node: Hex): Promise<string | null> {
    const r = await this.read<string>(BASENAMES.registry, 'resolver', [node])
    return r && r.toLowerCase() !== zeroAddress ? r.toLowerCase() : null
  }

  /** Forward lookup with the reason when there is no address. Invalid names count as unregistered. */
  lookup(name: string): Promise<NameLookup> {
    const c = checkBasename(name)
    if (!c.ok) return Promise.resolve({ status: 'unregistered' })
    return this.cached(`f:${c.name}`, async (): Promise<NameLookup> => {
      const node = namehash(c.name)
      const resolver = await this.resolverOf(node)
      if (!resolver) return { status: 'unregistered' }
      const a = await this.read<string>(resolver, 'addr', [node])
      return a && a.toLowerCase() !== zeroAddress ? { status: 'ok', address: a.toLowerCase() } : { status: 'no-address' }
    })
  }

  /** `name.basetest.eth` -> lowercase 0x address, or null. */
  async resolve(name: string): Promise<string | null> {
    const r = await this.lookup(name)
    return r.status === 'ok' ? r.address : null
  }

  /** Primary name of an address, accepted only when that name resolves back to the same address (else anyone could claim any name). */
  reverse(address: string): Promise<string | null> {
    if (!HEX40.test(address)) return Promise.resolve(null)
    const a = address.toLowerCase()
    return this.cached(`r:${a}`, async () => {
      const node = namehash(`${a.slice(2)}.${BASENAMES.reverseParent}`)
      const resolver = (await this.resolverOf(node)) ?? BASENAMES.legacyResolver
      const name = (await this.read<string>(resolver, 'name', [node])) || (await this.read<string>(BASENAMES.l2ReverseRegistrar, 'nameForAddr', [a]))
      if (!name) return null
      const c = checkBasename(name)
      if (!c.ok || c.name !== name) return null
      return (await this.resolve(c.name)) === a ? c.name : null
    })
  }

  /** Registration reads for scripts/vance-basename.mts (never cached: they are about to change). */
  available = (label: string) => this.read<boolean>(BASENAMES.controller, 'available', [label])
  price = (label: string, duration = ONE_YEAR_SEC) => this.read<bigint>(BASENAMES.controller, 'registerPrice', [label, duration])
}

/** Calldata for UpgradeableRegistrarController.register: the address (and text) records are written on the upgradeable
 *  resolver in the same transaction, and `reverseRecord` makes the name the sender's primary name. */
export function registerCalldata(label: string, owner: string, texts: Record<string, string> = {}, duration = ONE_YEAR_SEC): Hex {
  const node = namehash(label + SUFFIX)
  const o = owner.toLowerCase() as Hex
  const data = [
    encodeFunctionData({ abi: ABI, functionName: 'setAddr', args: [node, o] }),
    ...Object.entries(texts).map(([k, v]) => encodeFunctionData({ abi: ABI, functionName: 'setText', args: [node, k, v] })),
  ]
  return encodeFunctionData({
    abi: ABI, functionName: 'register',
    args: [{ name: label, owner: o, duration, resolver: BASENAMES.resolver, data, reverseRecord: true, coinTypes: [], signatureExpiry: 0n, signature: '0x' }],
  })
}

/** The browser's shared instance. */
export const basenames = new Basenames()
