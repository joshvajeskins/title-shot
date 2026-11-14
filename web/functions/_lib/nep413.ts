// NEP-413 signMessage: the pre-image, its hash, and ed25519 verification. Pure: no Env, no network. The browser uses it too.
import { sha256 } from '@noble/hashes/sha2.js'
import { BorshWriter } from '../../src/game/chain/borsh'
import { fromB64, toB64 } from '../../src/game/chain/bytes'
import { parsePublicKey, sign, verify, type KeyPair } from '../../src/game/chain/keys'

/** 2^31 + 413: the NEP-413 tag, so a signed message can never also be a valid transaction. */
export const NEP413_TAG = 2147484061

export interface Nep413Payload { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null }

/** The bytes that get hashed: borsh(u32 tag) || borsh(Payload). The nonce is a fixed [u8; 32] (no length prefix). */
export function nep413PreImage(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error('nonce must be 32 bytes')
  const w = new BorshWriter().u32(NEP413_TAG).string(p.message).bytes(p.nonce).string(p.recipient)
  const cb = p.callbackUrl
  if (cb === null || cb === undefined) w.u8(0)
  else w.u8(1).string(cb)
  return w.done()
}

export const nep413Hash = (p: Nep413Payload): Uint8Array => sha256(nep413PreImage(p))

/** Sign a payload with an ed25519 key pair; returns the base64 signature a wallet's signMessage would. */
export const signNep413 = (kp: KeyPair, p: Nep413Payload): string => toB64(sign(kp, nep413Hash(p)))

/** True only for a base64 signature of exactly 64 bytes that verifies under `ed25519:<base58>` over the payload hash. */
export function verifyNep413Signature(p: Nep413Payload, publicKey: string, signatureB64: string): boolean {
  try {
    const sig = fromB64(signatureB64)
    if (sig.length !== 64) return false
    return verify(sig, nep413Hash(p), parsePublicKey(publicKey))
  } catch {
    return false
  }
}
