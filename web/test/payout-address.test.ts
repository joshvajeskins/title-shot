// NearClient.payoutAddress / setPayoutAddress against a fake RPC: the contract's evm address view and set_evm_address,
// 1 yocto, signed with the guest's FULL-access key (never the session key), addresses validated before anything is signed.
import { describe, expect, it } from 'vitest'
import { decodeSignedTransaction } from '@near-js/transactions'
import { sha256 } from '@noble/hashes/sha2.js'
import { scriptedRpc, type ChainScript } from './helpers'
import { CONTRACT } from './fixtures'
import { NearClient } from '../src/game/near'
import { newGuestKeys, saveStored, type KeyStore } from '../src/game/nearKeys'
import { evmAddr, sameAddress } from '../src/game/chain/payout'
import { encodeTransaction } from '../src/game/chain/tx'
import { b58encode } from '../src/game/chain/base58'
import { fromB64 } from '../src/game/chain/bytes'
import { verify } from '../src/game/chain/keys'
import { GameError, type GameClient } from '../src/game/client'

const ME = 'calm-heron-12.play.titleshot.testnet'
const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7' // EIP-55 mixed case
class MemStore implements KeyStore {
  m = new Map<string, string>()
  get(k: string) { return this.m.get(k) ?? null }
  set(k: string, v: string) { this.m.set(k, v) }
  remove(k: string) { this.m.delete(k) }
}

function rig(opts: { account?: boolean; registered?: unknown; failure?: string } = {}) {
  const store = new MemStore()
  const keys = newGuestKeys()
  if (opts.account !== false) saveStored(store, keys, ME)
  const sent: string[] = []
  const reads: unknown[] = []
  let registered: unknown = opts.registered ?? null
  const script: ChainScript = {
    views: { [`${CONTRACT}:get_evm_address`]: (a: { account: string }) => { reads.push(a); return registered } },
    txs: () => (opts.failure
      ? { final_execution_status: 'EXECUTED', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${opts.failure}` } } } } }, transaction_outcome: {}, receipts_outcome: [] }
      : { final_execution_status: 'EXECUTED', status: { SuccessValue: '' }, transaction_outcome: {}, receipts_outcome: [] }),
    onSend: (b64) => {
      sent.push(b64)
      const fc = decodeSignedTransaction(fromB64(b64)).transaction.actions[0]!.functionCall!
      registered = JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args as ArrayLike<number>))).addr
    },
  }
  const { fetchFn } = scriptedRpc(script)
  const client = new NearClient({ contractId: CONTRACT, fetchFn, store, rpcUrls: ['https://rpc.test'], sleep: async () => undefined })
  return { client, keys, sent, reads }
}

describe('payout address helpers', () => {
  it('accepts any casing of 0x + 40 hex (no checksum required) and compares case-insensitively', () => {
    expect(evmAddr(`  ${ADDR} `)).toBe(ADDR.toLowerCase())
    expect(evmAddr(ADDR.toUpperCase().replace('0X', '0x'))).toBe(ADDR.toLowerCase())
    for (const bad of ['', '0x123', ADDR.slice(2), `${ADDR}00`, '0x' + 'g'.repeat(40), `0X${ADDR.slice(2)}`]) expect(() => evmAddr(bad)).toThrow(/0x followed by 40 hex/)
    expect(sameAddress(ADDR, ADDR.toLowerCase())).toBe(true)
    expect(sameAddress(ADDR, null)).toBe(false)
    expect(sameAddress('0x' + '1'.repeat(40), ADDR)).toBe(false)
  })
})

describe('NearClient payout address', () => {
  it('is an optional GameClient method pair that NearClient implements', () => {
    const c: GameClient = rig().client
    expect(typeof c.payoutAddress).toBe('function')
    expect(typeof c.setPayoutAddress).toBe('function')
  })
  it('payoutAddress reads get_evm_address for this account: lowercase, or null when unset, malformed or signed out', async () => {
    const r = rig({ registered: ADDR })
    expect(await r.client.payoutAddress()).toBe(ADDR.toLowerCase())
    expect(r.reads).toEqual([{ account: ME }])
    expect(await rig().client.payoutAddress()).toBeNull()
    expect(await rig({ registered: 'not an address' }).client.payoutAddress()).toBeNull()
    expect(await rig({ account: false, registered: ADDR }).client.payoutAddress()).toBeNull()
  })
  it('setPayoutAddress sends one set_evm_address, 1 yocto, signed by the full-access key (not the session key)', async () => {
    const r = rig()
    await r.client.setPayoutAddress(ADDR)
    expect(r.sent.length).toBe(1)
    const dec = decodeSignedTransaction(fromB64(r.sent[0]!))
    expect(dec.transaction.signerId).toBe(ME)
    expect(dec.transaction.receiverId).toBe(CONTRACT)
    const fc = dec.transaction.actions[0]!.functionCall!
    expect(fc.methodName).toBe('set_evm_address')
    expect(fc.deposit).toBe(1n)
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args as ArrayLike<number>)))).toEqual({ addr: ADDR.toLowerCase() })
    const body = encodeTransaction({ signerId: ME, receiverId: CONTRACT, nonce: dec.transaction.nonce, blockHash: b58encode(Uint8Array.from(dec.transaction.blockHash as ArrayLike<number>)), actions: [{ kind: 'functionCall', method: 'set_evm_address', args: Uint8Array.from(fc.args as ArrayLike<number>), gas: fc.gas, deposit: 1n }] }, r.keys.full.publicKey)
    const sig = Uint8Array.from(((dec.signature as any).ed25519Signature?.data ?? (dec.signature as any).data) as ArrayLike<number>)
    expect(verify(sig, sha256(body), r.keys.full.publicKey)).toBe(true)
    expect(verify(sig, sha256(body), r.keys.session.publicKey)).toBe(false)
    expect(await r.client.payoutAddress()).toBe(ADDR.toLowerCase())
  })
  it('the same address in another casing is already registered: nothing is sent', async () => {
    const r = rig({ registered: ADDR.toLowerCase() })
    await r.client.setPayoutAddress(ADDR)
    expect(r.sent.length).toBe(0)
  })
  it('a bad address is refused before anything is read or signed; no corner is E_NO_ACCOUNT; a contract failure is a GameError', async () => {
    const r = rig()
    await expect(r.client.setPayoutAddress('0x1234')).rejects.toMatchObject({ code: 'E_ADDRESS' })
    expect(r.sent.length + r.reads.length).toBe(0)
    await expect(rig({ account: false }).client.setPayoutAddress(ADDR)).rejects.toMatchObject({ code: 'E_NO_ACCOUNT' })
    const f = rig({ failure: 'E_ADDRESS: bad address' })
    await expect(f.client.setPayoutAddress(ADDR)).rejects.toBeInstanceOf(GameError)
    expect(f.sent.length).toBe(1)
  })
})
