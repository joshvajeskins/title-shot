// POST /api/preview: free compile of a sentence. Canonical (already forged) sentences return the final spec; others
// return the signed NEAR AI compile so the player sees exactly what the paid forge will produce.
import { z } from 'zod'
import { cleanSentence } from '../../src/game/client'
import { mapFighter, sentenceHash } from '../../src/game/chain/views'
import { toUiSpec, type Sim } from '../../src/sim'
import type { Spec } from '../../src/game/types'
import { cachedJson, getJson, putJson, scoped } from './cache'
import type { Chain } from './chain'
import { DEFAULTS, type Env } from './env'
import { ApiError } from './http'
import { compileFor } from './compiler'
import { compilerOf, isStandin, STANDIN_MODEL } from './standin'
import type { SignedResponse } from '../../src/game/chain/signature'
import { missKey, previewKey, type FighterLook } from './lookup'
import { CAPS, spendCap } from './ratelimit'
import { Ledger, LedgerClosed, type LedgerDeps, type Who } from './ledger'
import type { Usage } from './pricing'

export const previewBody = z.object({ sentence: z.string().min(1).max(400) }).strict()

export interface PreviewPayload {
  spec: Spec; canonical: boolean; portrait: string; hash: string; signer?: string
  /** who compiled a non-canonical preview: 'standin' = the staging referee (not NEAR AI); absent on canonical results */
  compiler?: 'nearai' | 'standin'
  /** the signature is internally consistent (text matches the request/response hashes, signature recovers to the stated address). NOT proof the signer is trusted: see `attested`. */
  verified?: boolean
  /** `verified` AND the signer is on the contract's active allowlist AND the signature kind is the contract's: what the paid forge would accept. null = could not check (contract unreachable or not deployed). Show "attested" only when true. */
  attested?: boolean | null
  raw?: string
  signature?: { text: string; signing_address: string; signature: string; kind: string }
  requestSha256?: string; responseSha256?: string
}

/** `who`: 'owner' when the request carried the tick secret (skips only the public spend caps). */
export interface PreviewDeps { env: Env; sim: Sim; chain: Chain | null; fetchFn: typeof fetch; who?: Who; ledger?: LedgerDeps }

const forgeClosed = (e: LedgerClosed) => new ApiError(503, 'FORGE_CLOSED', e.reason === 'public_daily'
  ? 'Free previews are paused for today: the AI budget is used up. They come back at midnight UTC; forged fighters still work.'
  : 'Free previews are paused: the AI budget is used up. Forged fighters still work.')

/** Compile through the spend ledger: reserve the worst case, settle to the usage NEAR AI reports (stand-in: free, no ledger). */
async function meteredCompile(d: PreviewDeps, model: string, sentence: string) {
  const ledger = isStandin(d.env) ? null : Ledger.of(d.env, { fetchFn: d.fetchFn, ...d.ledger })
  if (!ledger) return compileFor(d.env, d.sim, model, sentence, d.fetchFn)
  let hold
  try { hold = await ledger.reserve('compile', model, d.who ?? 'public') } catch (e) { throw e instanceof LedgerClosed ? forgeClosed(e) : e }
  const seen: { answered: boolean; usage: Usage | null } = { answered: false, usage: null }
  try {
    const c = await compileFor(d.env, d.sim, model, sentence, d.fetchFn, (usage) => { seen.answered = true; seen.usage = usage })
    await ledger.settle(hold, seen.usage ?? 'worst')
    return c
  } catch (e) {
    // answered 200 = billed (usage if it had one); an error status = not billed; no answer at all = maybe billed (worst case)
    await ledger.settle(hold, seen.answered ? seen.usage ?? 'worst' : e instanceof ApiError && (e.code === 'AI_STATUS' || e.code === 'AI_UNAVAILABLE') ? 'free' : 'worst')
    throw e
  }
}

/** Would the contract accept this address and signature kind? Reads the same config and list the paid forge checks. */
export async function attest(d: PreviewDeps, signed: SignedResponse, verified: boolean): Promise<boolean | null> {
  if (!d.chain) return null
  const chain = d.chain
  try {
    const [cfg, list] = await Promise.all([cachedJson(d.env.TS_KV, scoped(chain.id, 'cfg:model'), 300, () => chain.config()), cachedJson(d.env.TS_KV, scoped(chain.id, 'cfg:allowlist'), 300, () => chain.allowlist())])
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
  if (cached && (cached.result.compiler ?? 'nearai') === compilerOf(d.env)) return cached.result // a compile from the other referee is not reused

  const model = d.chain ? (await cachedJson(kv, scoped(d.chain.id, 'cfg:model'), 300, () => d.chain!.config())).model_id : isStandin(d.env) ? STANDIN_MODEL : d.env.NEARAI_MODEL ?? DEFAULTS.model
  await spendCap(kv, CAPS.previewCompile) // uncached compiles only: cache hits and canonical lookups above cost nothing
  const c = await meteredCompile(d, model, sentence)
  const n = d.sim.normalize(c.raw)
  if (!n.ok) {
    if (n.error.code === 'E_REFUSED') throw new ApiError(422, 'REFUSED', 'The referee refused this sentence. Try a different one.')
    throw new ApiError(422, 'BAD_COMPILE', `The compile was rejected (${n.error.code}). Try rewording.`)
  }
  const result: PreviewPayload = {
    spec: toUiSpec(n.spec), canonical: false, portrait: `/api/portrait/${hash}`, hash, compiler: compilerOf(d.env), signer: c.signed.signing_address, verified: c.verification.verified, attested: await attest(d, c.signed, c.verification.verified),
    raw: c.raw, signature: { text: c.signed.text, signing_address: c.signed.signing_address, signature: c.signed.signature, kind: c.signed.signature_kind },
    requestSha256: c.verification.requestSha256, responseSha256: c.verification.responseSha256,
  }
  const fighter: FighterLook = { look: n.spec.look, cry: n.spec.cry, school: n.spec.school, style: n.spec.style, name: n.spec.name }
  await putJson(kv, previewKey(hash), { result, fighter }, 3600)
  await Promise.all([kv.delete(missKey('portrait', hash)), kv.delete(missKey('cry', hash))]).catch(() => undefined) // a fresh preview ends any cached "unknown fighter"
  return result
}
