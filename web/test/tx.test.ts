import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction as theirEncode } from '@near-js/transactions'
import { PublicKey } from '@near-js/crypto'
import { b58decode, b58encode } from '../src/game/chain/base58'
import { equalBytes, fromB64 } from '../src/game/chain/bytes'
import { formatPublicKey, formatSecretKey, generateKeyPair, parsePublicKey, parseSecretKey, verify } from '../src/game/chain/keys'
import { encodeTransaction, fn, signTransaction, type Action } from '../src/game/chain/tx'

const kp = generateKeyPair()
const sessionKp = generateKeyPair()
const blockHash = b58encode(sha256(new TextEncoder().encode('block')))
const GAS = 300_000_000_000_000n

const mine: Action[] = [
  { kind: 'createAccount' },
  { kind: 'transfer', deposit: 150_000_000_000_000_000_000_000n },
  { kind: 'addKeyFullAccess', publicKey: formatPublicKey(kp.publicKey) },
  { kind: 'addKeyFunctionCall', publicKey: formatPublicKey(sessionKp.publicKey), allowance: 500_000_000_000_000_000_000_000n, receiverId: 'titleshot.testnet', methodNames: ['challenge'] },
  fn('challenge', { belt_id: 1, sentence: 'a very polite kraken' }, GAS, 0n),
  fn('deposit_for', { account: 'a.play.titleshot.testnet' }, 30_000_000_000_000n, 500_000_000_000_000_000_000_000n),
  fn('set_purse_address', { belt: 1, season: 2, addr: '0x' + 'ab'.repeat(20) }, 30_000_000_000_000n, 1n),
]

const theirs = () => [
  actionCreators.createAccount(),
  actionCreators.transfer(150_000_000_000_000_000_000_000n),
  actionCreators.addKey(PublicKey.from(formatPublicKey(kp.publicKey)), actionCreators.fullAccessKey()),
  actionCreators.addKey(PublicKey.from(formatPublicKey(sessionKp.publicKey)), actionCreators.functionCallAccessKey('titleshot.testnet', ['challenge'], 500_000_000_000_000_000_000_000n)),
  actionCreators.functionCall('challenge', new TextEncoder().encode(JSON.stringify({ belt_id: 1, sentence: 'a very polite kraken' })), GAS, 0n),
  actionCreators.functionCall('deposit_for', new TextEncoder().encode(JSON.stringify({ account: 'a.play.titleshot.testnet' })), 30_000_000_000_000n, 500_000_000_000_000_000_000_000n),
  actionCreators.functionCall('set_purse_address', new TextEncoder().encode(JSON.stringify({ belt: 1, season: 2, addr: '0x' + 'ab'.repeat(20) })), 30_000_000_000_000n, 1n),
]

describe('NEAR transaction encoding matches the reference implementation (@near-js/transactions)', () => {
  it('every action kind encodes to the same bytes', () => {
    const ref = createTransaction('play.titleshot.testnet', PublicKey.from(formatPublicKey(kp.publicKey)), 'titleshot.testnet', 12345, theirs(), b58decode(blockHash))
    const expected = theirEncode(ref)
    const got = encodeTransaction({ signerId: 'play.titleshot.testnet', receiverId: 'titleshot.testnet', nonce: 12345n, blockHash, actions: mine }, kp.publicKey)
    expect(equalBytes(got, expected)).toBe(true)
  })
  it('a signed transaction decodes with the reference decoder and the signature verifies', () => {
    const signed = signTransaction({ signerId: 'a.play.titleshot.testnet', receiverId: 'titleshot.testnet', nonce: 7n, blockHash, actions: [mine[4]!] }, sessionKp)
    const dec = decodeSignedTransaction(fromB64(signed.base64))
    expect(dec.transaction.signerId).toBe('a.play.titleshot.testnet')
    expect(dec.transaction.receiverId).toBe('titleshot.testnet')
    expect(dec.transaction.nonce).toBe(7n)
    expect(dec.transaction.actions.length).toBe(1)
    const fc = dec.transaction.actions[0]!.functionCall!
    expect(fc.methodName).toBe('challenge')
    expect(fc.gas).toBe(GAS)
    expect(fc.deposit).toBe(0n)
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args as ArrayLike<number>)))).toEqual({ belt_id: 1, sentence: 'a very polite kraken' })
    const body = encodeTransaction({ signerId: 'a.play.titleshot.testnet', receiverId: 'titleshot.testnet', nonce: 7n, blockHash, actions: [mine[4]!] }, sessionKp.publicKey)
    expect(b58encode(sha256(body))).toBe(signed.hash)
    const sigBytes = (dec.signature as any).ed25519Signature?.data ?? (dec.signature as any).signature?.data ?? (dec.signature as any).data
    expect(verify(Uint8Array.from(sigBytes as ArrayLike<number>), sha256(body), sessionKp.publicKey)).toBe(true)
  })
  it('a function-call key the guest endpoint adds is restricted to challenge on the contract', () => {
    const signed = signTransaction({ signerId: 'play.titleshot.testnet', receiverId: 'g.play.titleshot.testnet', nonce: 1n, blockHash, actions: mine.slice(0, 4) }, kp)
    const dec = decodeSignedTransaction(fromB64(signed.base64))
    const key = dec.transaction.actions[3]!.addKey!
    expect(key.accessKey.permission.functionCall?.receiverId).toBe('titleshot.testnet')
    expect(key.accessKey.permission.functionCall?.methodNames).toEqual(['challenge'])
    expect(key.accessKey.permission.functionCall?.allowance).toBe(500_000_000_000_000_000_000_000n)
    expect(dec.transaction.actions[2]!.addKey!.accessKey.permission.fullAccess).toBeDefined()
  })
})

describe('keys and base58', () => {
  it('secret keys round trip through the near string format', () => {
    const k = generateKeyPair()
    const back = parseSecretKey(formatSecretKey(k))
    expect(equalBytes(back.seed, k.seed)).toBe(true)
    expect(equalBytes(back.publicKey, k.publicKey)).toBe(true)
    expect(equalBytes(parsePublicKey(formatPublicKey(k.publicKey)), k.publicKey)).toBe(true)
  })
  it('malformed keys are refused', () => {
    expect(() => parseSecretKey('secp256k1:abc')).toThrow()
    expect(() => parseSecretKey('ed25519:abc')).toThrow()
    expect(() => parsePublicKey('ed25519:' + '1'.repeat(10))).toThrow()
    expect(() => b58decode('0OIl')).toThrow()
  })
  it('base58 handles leading zeros', () => {
    const b = Uint8Array.of(0, 0, 1, 2, 3, 255)
    expect(equalBytes(b58decode(b58encode(b)), b)).toBe(true)
    expect(b58encode(Uint8Array.of(0, 0))).toBe('11')
  })
})
