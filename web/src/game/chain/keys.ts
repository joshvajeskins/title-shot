// ed25519 keys in NEAR's string format. Secret keys never leave the caller's memory/storage.
import { ed25519 } from '@noble/curves/ed25519.js'
import { b58decode, b58encode } from './base58'

export interface KeyPair {
  /** 32-byte ed25519 seed */
  seed: Uint8Array
  publicKey: Uint8Array
}

/** Parse "ed25519:<base58>" secret keys: 64 bytes (seed||pub) or a bare 32-byte seed. */
export function parseSecretKey(s: string): KeyPair {
  if (!s.startsWith('ed25519:')) throw new Error('secret key must be ed25519:<base58>')
  const raw = b58decode(s.slice('ed25519:'.length))
  if (raw.length !== 64 && raw.length !== 32) throw new Error('secret key must decode to 32 or 64 bytes')
  const seed = raw.slice(0, 32)
  return { seed, publicKey: ed25519.getPublicKey(seed) }
}

export function parsePublicKey(s: string): Uint8Array {
  if (!s.startsWith('ed25519:')) throw new Error('public key must be ed25519:<base58>')
  const raw = b58decode(s.slice('ed25519:'.length))
  if (raw.length !== 32) throw new Error('public key must decode to 32 bytes')
  return raw
}

export const formatPublicKey = (pk: Uint8Array): string => 'ed25519:' + b58encode(pk)

export function formatSecretKey(kp: KeyPair): string {
  const full = new Uint8Array(64)
  full.set(kp.seed, 0)
  full.set(kp.publicKey, 32)
  return 'ed25519:' + b58encode(full)
}

export function generateKeyPair(): KeyPair {
  const seed = ed25519.utils.randomSecretKey()
  return { seed, publicKey: ed25519.getPublicKey(seed) }
}

export const sign = (kp: KeyPair, msg: Uint8Array): Uint8Array => ed25519.sign(msg, kp.seed)

export function verify(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pk)
  } catch {
    return false
  }
}
