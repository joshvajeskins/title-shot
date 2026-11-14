// Basenames (Base Sepolia, *.basetest.eth) against a scripted eth_call RPC: forward and reverse lookups, the payout
// dialog's pure logic, caching, and the register calldata scripts/vance-basename.mts sends.
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, namehash, parseAbi, zeroAddress, type Hex } from 'viem'
import { Rpc } from '../src/game/chain/rpc'
import {
  BASENAMES, Basenames, VANCE_BASE_ADDRESS, checkBasename, inputKey, parsePayoutInput, registerCalldata, resolvePayout, saveTarget,
} from '../src/game/chain/basenames'

const ABI = parseAbi([
  'function resolver(bytes32 node) view returns (address)',
  'function addr(bytes32 node) view returns (address)',
  'function name(bytes32 node) view returns (string)',
  'function nameForAddr(address addr) view returns (string)',
  'function setAddr(bytes32 node, address a)',
  'function setText(bytes32 node, string key, string value)',
  'function register((string name, address owner, uint256 duration, address resolver, bytes[] data, bool reverseRecord, uint256[] coinTypes, uint256 signatureExpiry, bytes signature) request) payable',
])
const VANCE = VANCE_BASE_ADDRESS
const OTTO = '0x52908400098527886e0f7030069857d2e4169ee7'
const MALLORY = '0x8ba1f109551bd432803012645ac136ddd64dba72'
const R = BASENAMES.resolver
const revNode = (a: string) => namehash(`${a.slice(2)}.${BASENAMES.reverseParent}`)

interface World { resolvers: Map<Hex, string>; addrs: Map<Hex, string>; names: Map<Hex, string>; ensip19: Map<string, string> }
function world(): World {
  const w: World = { resolvers: new Map(), addrs: new Map(), names: new Map(), ensip19: new Map() }
  const reg = (name: string, addr: string | null) => { w.resolvers.set(namehash(name), R); if (addr) w.addrs.set(namehash(name), addr) }
  reg('velvetvance.basetest.eth', VANCE)
  reg('otto-ink.basetest.eth', OTTO)
  reg('ghost.basetest.eth', null) // registered, no address record
  w.names.set(revNode(VANCE), 'velvetvance.basetest.eth')
  w.names.set(revNode(MALLORY), 'velvetvance.basetest.eth') // Mallory claims Vance's name as her primary name
  w.ensip19.set(OTTO, 'otto-ink.basetest.eth')
  return w
}

function rig(opts: { down?: boolean; w?: World; now?: () => number } = {}) {
  const w = opts.w ?? world()
  const calls: string[] = []
  let down = !!opts.down
  const fetchFn = (async (_url: string, init: { body: string }) => {
    if (down) throw new Error('connect ECONNREFUSED')
    const req = JSON.parse(init.body) as { id: number; method: string; params: [{ to: string; data: Hex }, string] }
    const { to, data } = req.params[0]
    const { functionName, args } = decodeFunctionData({ abi: ABI, data })
    calls.push(functionName)
    const ok = (result: Hex) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    const node = args?.[0] as Hex
    const t = to.toLowerCase()
    if (functionName === 'resolver' && t === BASENAMES.registry) return ok(encodeFunctionResult({ abi: ABI, functionName, result: (w.resolvers.get(node) ?? zeroAddress) as Hex }))
    if (functionName === 'addr' && t === R) return ok(encodeFunctionResult({ abi: ABI, functionName, result: (w.addrs.get(node) ?? zeroAddress) as Hex }))
    if (functionName === 'name' && t === BASENAMES.legacyResolver) return ok(encodeFunctionResult({ abi: ABI, functionName, result: w.names.get(node) ?? '' }))
    if (functionName === 'nameForAddr' && t === BASENAMES.l2ReverseRegistrar) return ok(encodeFunctionResult({ abi: ABI, functionName, result: w.ensip19.get(String(args?.[0]).toLowerCase()) ?? '' }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } }))
  }) as unknown as typeof fetch
  const bn = new Basenames(new Rpc({ urls: ['https://base-sepolia.test'], fetchFn, timeoutMs: 2000 }), 30_000, opts.now)
  return { bn, calls, setDown: (v: boolean) => { down = v } }
}

describe('checkBasename', () => {
  it('normalises case, a bare label and a trailing dot to label.basetest.eth', () => {
    expect(checkBasename('VelvetVance')).toEqual({ ok: true, name: 'velvetvance.basetest.eth', label: 'velvetvance' })
    expect(checkBasename('  otto-ink.BASETEST.eth. ')).toMatchObject({ ok: true, name: 'otto-ink.basetest.eth' })
  })
  it.each([
    ['', 'Enter a name'], ['ab', 'at least 3'], ['velvetvance.base.eth', 'mainnet'], ['sub.otto.basetest.eth', 'Only Base Sepolia'],
    ['vеlvetvance', 'unicode'], ['-otto', 'hyphen'], ['otto-', 'hyphen'], ['ot--to', 'hyphen'], ['otto_ink', 'hyphen'], ['x'.repeat(64), 'hyphen'],
  ])('refuses %j', (input, why) => {
    const c = checkBasename(input)
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toContain(why)
  })
})

describe('parsePayoutInput', () => {
  it('sorts input into empty, address (lowercased), name and invalid', () => {
    expect(parsePayoutInput('   ')).toEqual({ kind: 'empty' })
    expect(parsePayoutInput(' 0x52908400098527886E0F7030069857D2E4169EE7 ')).toEqual({ kind: 'address', address: OTTO })
    expect(parsePayoutInput('Otto-Ink')).toEqual({ kind: 'name', name: 'otto-ink.basetest.eth' })
    expect(parsePayoutInput('0x1234').kind).toBe('invalid')
    expect(parsePayoutInput('0x' + 'g'.repeat(40)).kind).toBe('invalid')
    expect(parsePayoutInput(zeroAddress)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('burned') })
    expect(parsePayoutInput('otto.base.eth').kind).toBe('invalid')
  })
})

describe('forward lookups', () => {
  it('resolves a registered name to its lowercase address', async () => {
    const { bn } = rig()
    expect(await bn.resolve('velvetvance.basetest.eth')).toBe(VANCE)
    expect(await bn.resolve('OTTO-INK')).toBe(OTTO)
  })
  it('tells unregistered names from names without an address, and never queries for invalid ones', async () => {
    const { bn, calls } = rig()
    expect(await bn.lookup('nobody-here')).toEqual({ status: 'unregistered' })
    expect(await bn.lookup('ghost')).toEqual({ status: 'no-address' })
    const before = calls.length
    expect(await bn.lookup('x.base.eth')).toEqual({ status: 'unregistered' })
    expect(await bn.resolve('a')).toBeNull()
    expect(calls.length).toBe(before)
  })
})

describe('reverse lookups', () => {
  it('returns the primary name only when it resolves back to the same address', async () => {
    const { bn } = rig()
    expect(await bn.reverse(VANCE.toUpperCase().replace('0X', '0x'))).toBe('velvetvance.basetest.eth')
    expect(await bn.reverse(MALLORY)).toBeNull() // claims velvetvance, which points at Vance
    expect(await bn.reverse('0x000000000000000000000000000000000000dead')).toBeNull()
    expect(await bn.reverse('not-an-address')).toBeNull()
  })
  it('falls back to the ENSIP-19 reverse registrar', async () => {
    const { bn } = rig()
    expect(await bn.reverse(OTTO)).toBe('otto-ink.basetest.eth')
  })
})

describe('cache', () => {
  it('answers repeats from memory until the TTL passes', async () => {
    let t = 1_000
    const { bn, calls } = rig({ now: () => t })
    await bn.resolve('velvetvance')
    const n = calls.length
    await bn.resolve('velvetvance.basetest.eth')
    expect(calls.length).toBe(n)
    t += 30_001
    await bn.resolve('velvetvance')
    expect(calls.length).toBe(n * 2)
  })
  it('does not cache a network failure', async () => {
    const r = rig({ down: true })
    await expect(r.bn.resolve('velvetvance')).rejects.toThrow(/unavailable/i)
    r.setDown(false)
    expect(await r.bn.resolve('velvetvance')).toBe(VANCE)
  })
})

describe('payout dialog logic', () => {
  it('shows a name with its address, and explains names that cannot be paid', async () => {
    const { bn } = rig()
    expect(await resolvePayout(parsePayoutInput('velvetvance'), bn)).toEqual({ state: 'resolved', key: 'velvetvance.basetest.eth', address: VANCE, name: 'velvetvance.basetest.eth' })
    expect(await resolvePayout(parsePayoutInput(VANCE), bn)).toEqual({ state: 'resolved', key: VANCE, address: VANCE, name: 'velvetvance.basetest.eth' })
    expect(await resolvePayout(parsePayoutInput('nobody-here'), bn)).toMatchObject({ state: 'failed', reason: expect.stringContaining('not registered') })
    expect(await resolvePayout(parsePayoutInput('ghost'), bn)).toMatchObject({ state: 'failed', reason: expect.stringContaining('no address') })
    expect(await resolvePayout(parsePayoutInput('0x12'), bn)).toEqual({ state: 'idle' })
  })
  it('keeps a pasted address usable when Base Sepolia is unreachable, but never guesses a name', async () => {
    const { bn } = rig({ down: true })
    expect(await resolvePayout(parsePayoutInput(OTTO), bn)).toEqual({ state: 'resolved', key: OTTO, address: OTTO, name: null })
    expect(await resolvePayout(parsePayoutInput('otto-ink'), bn)).toMatchObject({ state: 'failed', reason: expect.stringContaining("Couldn't reach") })
  })
  it('saves only the address resolved for this exact input, and nothing already on file', () => {
    const name = parsePayoutInput('velvetvance')
    const resolved = { state: 'resolved' as const, key: inputKey(name), address: VANCE, name: 'velvetvance.basetest.eth' }
    expect(saveTarget(name, resolved, null)).toBe(VANCE)
    expect(saveTarget(name, { state: 'resolving', key: inputKey(name) }, null)).toBeNull()
    expect(saveTarget(name, { ...resolved, key: 'otto-ink.basetest.eth' }, null)).toBeNull() // stale answer for the previous input
    expect(saveTarget(name, resolved, VANCE.toUpperCase().replace('0X', '0x'))).toBeNull()
    expect(saveTarget(parsePayoutInput(OTTO), { state: 'idle' }, null)).toBe(OTTO)
    expect(saveTarget(parsePayoutInput(OTTO), { state: 'idle' }, OTTO)).toBeNull()
    expect(saveTarget(parsePayoutInput('ab'), resolved, null)).toBeNull()
    expect(saveTarget(parsePayoutInput(''), resolved, null)).toBeNull()
  })
})

describe('registerCalldata', () => {
  it('registers for one year on the upgradeable resolver, sets the addr record first and the primary name', () => {
    const data = registerCalldata('velvetvance', VANCE, { url: 'https://preview.title-shot.pages.dev' })
    const { functionName, args } = decodeFunctionData({ abi: ABI, data })
    expect(functionName).toBe('register')
    const req = args[0] as { name: string; owner: string; duration: bigint; resolver: string; data: readonly Hex[]; reverseRecord: boolean; coinTypes: readonly bigint[]; signatureExpiry: bigint }
    expect(req).toMatchObject({ name: 'velvetvance', duration: 31_536_000n, reverseRecord: true, coinTypes: [], signatureExpiry: 0n })
    expect(req.owner.toLowerCase()).toBe(VANCE)
    expect(req.resolver.toLowerCase()).toBe(BASENAMES.resolver)
    const node = namehash('velvetvance.basetest.eth')
    const first = decodeFunctionData({ abi: ABI, data: req.data[0]! })
    expect(first.functionName).toBe('setAddr')
    expect(first.args?.[0]).toBe(node)
    expect(String(first.args?.[1]).toLowerCase()).toBe(VANCE)
    expect(decodeFunctionData({ abi: ABI, data: req.data[1]! }).args).toEqual([node, 'url', 'https://preview.title-shot.pages.dev'])
  })
})
