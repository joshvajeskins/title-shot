import { sha256 } from '@noble/hashes/sha2.js'
import { BorshWriter } from './borsh'
import { b58decode, b58encode } from './base58'
import { parsePublicKey, sign, type KeyPair } from './keys'
import { toB64 } from './bytes'

export type Action =
  | { kind: 'createAccount' }
  | { kind: 'transfer'; deposit: bigint }
  | { kind: 'functionCall'; method: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { kind: 'addKeyFullAccess'; publicKey: string }
  | { kind: 'addKeyFunctionCall'; publicKey: string; allowance: bigint | null; receiverId: string; methodNames: string[] }

export interface TxParams {
  signerId: string
  receiverId: string
  nonce: bigint
  blockHash: string
  actions: Action[]
}

const writePublicKey = (w: BorshWriter, pk: Uint8Array) => w.u8(0).bytes(pk)

function writeAction(w: BorshWriter, a: Action) {
  switch (a.kind) {
    case 'createAccount':
      w.u8(0)
      break
    case 'transfer':
      w.u8(3).u128(a.deposit)
      break
    case 'functionCall':
      w.u8(2).string(a.method).vecU8(a.args).u64(a.gas).u128(a.deposit)
      break
    case 'addKeyFullAccess':
      w.u8(5)
      writePublicKey(w, parsePublicKey(a.publicKey))
      w.u64(0).u8(1) // nonce 0, permission FullAccess
      break
    case 'addKeyFunctionCall':
      w.u8(5)
      writePublicKey(w, parsePublicKey(a.publicKey))
      w.u64(0).u8(0) // nonce 0, permission FunctionCall
      w.option(a.allowance, (v) => w.u128(v))
      w.string(a.receiverId)
      w.vec(a.methodNames, (m) => w.string(m))
      break
  }
}

export function encodeTransaction(p: TxParams, publicKey: Uint8Array): Uint8Array {
  const w = new BorshWriter()
  w.string(p.signerId)
  writePublicKey(w, publicKey)
  w.u64(p.nonce)
  w.string(p.receiverId)
  w.bytes(b58decode(p.blockHash))
  w.vec(p.actions, (a) => writeAction(w, a))
  return w.done()
}

export interface SignedTx {
  hash: string
  base64: string
  bytes: Uint8Array
}

export function signTransaction(p: TxParams, kp: KeyPair): SignedTx {
  const body = encodeTransaction(p, kp.publicKey)
  const digest = sha256(body)
  const sig = sign(kp, digest)
  const bytes = new BorshWriter().bytes(body).u8(0).bytes(sig).done()
  return { hash: b58encode(digest), base64: toB64(bytes), bytes }
}

export const fn = (method: string, args: unknown, gas: bigint, deposit = 0n): Action => ({
  kind: 'functionCall', method, args: new TextEncoder().encode(JSON.stringify(args ?? {})), gas, deposit,
})
