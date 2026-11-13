// POST /api/preview: free compile of a sentence. Canonical (already forged) sentences return the final spec; others
// return the signed NEAR AI compile so the player sees exactly what the paid forge will produce.
import { z } from 'zod'
import { cleanSentence } from '../../src/game/client'
import { mapFighter, sentenceHash } from '../../src/game/chain/views'
import { toUiSpec, type Sim } from '../../src/sim'
import type { Spec } from '../../src/game/types'
import { cachedJson, getJson, putJson } from './cache'
import type { Chain } from './chain'
import { DEFAULTS, type Env } from './env'
import { ApiError } from './http'
import { compile } from './nearai'
import type { SignedResponse } from '../../src/game/chain/signature'
import { missKey, previewKey, type FighterLook } from './lookup'
import { CAPS, spendCap } from './ratelimit'

export const previewBody = z.object({ sentence: z.string().min(1).max(400) }).strict()

export interface PreviewPayload {
  spec: Spec; canonical: boolean; portrait: string; hash: string; signer?: string
  /** the signature is internally consistent (text matches the request/response hashes, signature recovers to the stated address). NOT proof the signer is trusted: see `attested`. */
  verified?: boolean
  /** `verified` AND the signer is on the contract's active allowlist AND the signature kind is the contract's: what the paid forge would accept. null = could not check (contract unreachable or not deployed). Show "attested" only when true. */
  attested?: boolean | null
  raw?: string
  signature?: { text: string; signing_address: string; signature: string; kind: string }
  requestSha256?: string; responseSha256?: string
}

export interface PreviewDeps { env: Env; sim: Sim; chain: Chain | null; fetchFn: typeof fetch }

/** Would the contract accept this address and signature kind? Reads the same config and list the paid forge checks. */
export async function attest(d: PreviewDeps, signed: SignedResponse, verified: boolean): Promise<boolean | null> {
  if (!d.chain) return null
  const chain = d.chain
  try {
    const [cfg, list] = await Promise.all([cachedJson(d.env.TS_KV, 'cfg:model', 300, () => chain.config()), cachedJson(d.env.TS_KV, 'cfg:allowlist', 300, () => chain.allowlist())])
    const norm = (a: string) => (a.startsWith('0x') ? a : `0x${a}`).toLowerCase()
    return verified && cfg.signature_kind === signed.signature_kind && (list.active ?? []).map(norm).includes(norm(signed.signing_address))
  } catch { return null }
}

export async function runPreview(d: PreviewDeps, input: string): Promise<PreviewPayload> {
  const sentence = cleanSentence(input)
  const problem = d.sim.checkSentence(sentence)
  if (problem) throw new ApiError(400, 'BAD_SENTENCE', 'The sentence must be 3 to 120 characters with no control characters.')
  const hash = sentenceHash(sentence)
  const kv = d.env.TS_KV

  if (d.chain) {
    const existing = await d.chain.fighterBySentence(sentence)
    if (existing) {
      const f = mapFighter(existing)
      return { spec: f.spec, canonical: true, portrait: f.portrait ?? `/api/portrait/${hash}`, hash, signer: existing.signer, attested: true }
    }
  }
  const cached = await getJson<{ result: PreviewPayload }>(kv, previewKey(hash))
  if (cached) return cached.result

  const model = d.chain ? (await cachedJson(kv, 'cfg:model', 300, () => d.chain!.config())).model_id : d.env.NEARAI_MODEL ?? DEFAULTS.model
  await spendCap(kv, CAPS.previewCompile) // uncached compiles only: cache hits and canonical lookups above cost nothing
  const c = await compile(d.env, d.sim, model, sentence, d.fetchFn)
  const n = d.sim.normalize(c.raw)
  if (!n.ok) {
    if (n.error.code === 'E_REFUSED') throw new ApiError(422, 'REFUSED', 'The referee refused this sentence. Try a different one.')
    throw new ApiError(422, 'BAD_COMPILE', `The compile was rejected (${n.error.code}). Try rewording.`)
  }
  const result: PreviewPayload = {
    spec: toUiSpec(n.spec), canonical: false, portrait: `/api/portrait/${hash}`, hash, signer: c.signed.signing_address, verified: c.verification.verified, attested: await attest(d, c.signed, c.verification.verified),
    raw: c.raw, signature: { text: c.signed.text, signing_address: c.signed.signing_address, signature: c.signed.signature, kind: c.signed.signature_kind },
    requestSha256: c.verification.requestSha256, responseSha256: c.verification.responseSha256,
  }
  const fighter: FighterLook = { look: n.spec.look, cry: n.spec.cry, school: n.spec.school, style: n.spec.style, name: n.spec.name }
  await putJson(kv, previewKey(hash), { result, fighter }, 3600)
  await Promise.all([kv.delete(missKey('portrait', hash)), kv.delete(missKey('cry', hash))]).catch(() => undefined) // a fresh preview ends any cached "unknown fighter"
  return result
}
