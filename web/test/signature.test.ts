import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './helpers'
import { eip191Digest, expectedText, recoverAddress, sha256Hex, verifySigned } from '../src/game/chain/signature'
import { fromB64, fromUtf8, utf8, toHex } from '../src/game/chain/bytes'

const vec = JSON.parse(readFileSync(join(ROOT, 'vectors/synthetic-eip191-1.json'), 'utf8'))
const prefix = fromUtf8(fromB64(vec.prefix_b64))
const suffix = fromUtf8(fromB64(vec.suffix_b64))
const allow = (vec.allowlist as string[]).map((a) => a.toLowerCase())

type Case = { name: string; sentence: string; response: string; signature_hex: string; signature_kind: string; signing_algo: string; expect: { code: string; ok: boolean } }
const find = (name: string) => (vec.cases as Case[]).find((x) => x.name === name)!
const build = (c: Case) => utf8(prefix + JSON.stringify(c.sentence).slice(1, -1) + suffix)
const textOf = (c: Case) => expectedText(c.signature_kind, vec.model_id, build(c), utf8(c.response))

describe('NEAR AI signature verification against the recorded-format vector (27 cases from the contract spike)', () => {
  it('has the cases', () => expect(vec.cases.length).toBe(27))
  it('valid cases recover an allowlisted signer over the exact rebuilt text', () => {
    const valid = (vec.cases as Case[]).filter((c) => c.expect.ok && c.signing_algo === 'ecdsa')
    expect(valid.length).toBeGreaterThanOrEqual(4)
    for (const c of valid) {
      const signer = recoverAddress(textOf(c)!, c.signature_hex.replace(/^0x/i, ''))
      expect(allow, c.name).toContain(signer)
    }
  })
  it('tampered response, sentence or kind never recovers an allowlisted signer', () => {
    for (const name of ['tampered_response_byte', 'tampered_response_trailing_newline', 'tampered_sentence', 'signed_with_different_model_id', 'gateway_sig_submitted_as_provider_tee', 'provider_tee_sig_submitted_as_gateway']) {
      const c = find(name)
      let signer = ''
      try { signer = recoverAddress(textOf(c)!, c.signature_hex.replace(/^0x/i, '')) } catch { /* malformed is also a rejection */ }
      expect(allow, name).not.toContain(signer)
    }
  })
  it('malformed signatures throw instead of recovering something', () => {
    for (const name of ['truncated_sig_64_bytes', 'overlong_sig_66_bytes', 'bad_recovery_byte_2', 'bad_recovery_byte_29', 'non_hex_signature']) {
      expect(() => recoverAddress('anything', find(name).signature_hex), name).toThrow()
    }
  })
  it('verifySigned reports text mismatch, bad signer, wrong algo and unknown kind separately', () => {
    const c = find('valid_provider_tee_v27_28')
    const req = build(c)
    const resp = utf8(c.response)
    const text = expectedText('provider_tee', vec.model_id, req, resp)!
    const base = { text, signature: c.signature_hex, signing_address: vec.allowlist[0], signing_algo: 'ecdsa', signature_kind: 'provider_tee' }
    const ok = verifySigned(vec.model_id, req, resp, base)
    expect(ok.verified).toBe(true)
    expect(ok.requestSha256).toBe(sha256Hex(req))
    expect(verifySigned(vec.model_id, req, utf8(c.response + ' '), base).textMatches).toBe(false)
    expect(verifySigned(vec.model_id, req, utf8(c.response + ' '), base).verified).toBe(false)
    expect(verifySigned(vec.model_id, req, resp, { ...base, signing_address: '0x' + '11'.repeat(20) }).signatureValid).toBe(false)
    expect(verifySigned(vec.model_id, req, resp, { ...base, signing_algo: 'ed25519' }).verified).toBe(false)
    expect(verifySigned(vec.model_id, req, resp, { ...base, signature_kind: 'mystery' }).verified).toBe(false)
  })
  it('EIP-191 digest is the keccak of the prefixed message', () => {
    expect(toHex(eip191Digest('hello'))).toBe('50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750')
  })
})
