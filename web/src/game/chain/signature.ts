// NEAR AI Cloud response-signature verification (gateway / provider_tee, ECDSA EIP-191). Runtime-neutral.
// Text rules: provider_tee = "{model}:{sha256(req)}:{sha256(resp)}", gateway = "{sha256(req)}:{sha256(resp)}".
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concat, fromHex, toHex, utf8 } from './bytes'

export const sha256Hex = (b: Uint8Array): string => toHex(sha256(b))

/** Ethereum personal-message digest of a UTF-8 message. */
export function eip191Digest(text: string): Uint8Array {
  const body = utf8(text)
  return keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${body.length}`), body))
}

/** Recover the 0x signer address of a 65-byte (r||s||v) EIP-191 signature. Throws on malformed input. */
export function recoverAddress(text: string, sigHex: string): string {
  const sig = fromHex(sigHex)
  if (sig.length !== 65) throw new Error('signature must be 65 bytes')
  let v = sig[64]!
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) throw new Error('bad recovery id')
  // noble v2 "recovered" format: recovery byte first, then r||s
  const recovered = concat(Uint8Array.of(v), sig.slice(0, 64))
  const pub = secp256k1.recoverPublicKey(recovered, eip191Digest(text), { prehash: false }) // compressed 33 bytes
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false)
  return '0x' + toHex(keccak_256(uncompressed.slice(1)).slice(12))
}

export type SignatureKind = 'provider_tee' | 'gateway'

export function expectedText(kind: string, model: string, req: Uint8Array, resp: Uint8Array): string | null {
  const h = `${sha256Hex(req)}:${sha256Hex(resp)}`
  if (kind === 'provider_tee') return `${model}:${h}`
  if (kind === 'gateway') return h
  return null
}

export interface SignedResponse {
  text: string; signature: string; signing_address: string; signing_algo: string; signature_kind: string
}

export interface Verification {
  textMatches: boolean
  signatureValid: boolean
  verified: boolean
  recovered: string | null
  requestSha256: string
  responseSha256: string
}

const with0x = (a: string) => (a.startsWith('0x') ? a : `0x${a}`).toLowerCase()

export function verifySigned(model: string, req: Uint8Array, resp: Uint8Array, sig: SignedResponse): Verification {
  const expected = expectedText(sig.signature_kind, model, req, resp)
  const textMatches = expected !== null && expected === sig.text
  let recovered: string | null = null
  let signatureValid = false
  try {
    recovered = sig.signing_algo === 'ecdsa' ? recoverAddress(sig.text, sig.signature) : null
    signatureValid = recovered !== null && recovered === with0x(sig.signing_address)
  } catch { /* malformed signature: not valid */ }
  return { textMatches, signatureValid, verified: textMatches && signatureValid, recovered, requestSha256: sha256Hex(req), responseSha256: sha256Hex(resp) }
}
