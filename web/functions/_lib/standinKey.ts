// The stand-in referee's secp256k1 key: parse, address, EIP-191 signature. No JSON or wasm imports, so scripts can use it too.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concat, fromHex, toHex } from '../../src/game/chain/bytes'
import { eip191Digest } from '../../src/game/chain/signature'
import { ApiError } from './http'

export function secretKey(hex: string | undefined): Uint8Array {
  const h = (hex ?? '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new ApiError(503, 'STANDIN_NO_KEY', 'The stand-in referee has no signing key.')
  return fromHex(h)
}

/** 0x-address of a 32-byte hex private key (what the staging contract's allowlist holds). */
export function standinAddress(keyHex: string): string {
  const pub = secp256k1.getPublicKey(secretKey(keyHex), false)
  return '0x' + toHex(keccak_256(pub.slice(1)).slice(12))
}

/** 65-byte r||s||v(27/28) EIP-191 signature, low-s, deterministic (RFC 6979), hex without 0x. */
export function signText(sk: Uint8Array, text: string): string {
  const sig = secp256k1.sign(eip191Digest(text), sk, { prehash: false, format: 'recovered' }) // recovery byte first
  return toHex(concat(sig.slice(1), Uint8Array.of(sig[0]! + 27)))
}

