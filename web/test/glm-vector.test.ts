// The preview compile replayed against the REAL recorded glm-5.3-flash exchanges (vectors/nearai-real-*-low.json): the worker
// sends the wasm build_request bytes for z-ai/glm-5.3-flash, and NEAR AI's provider_tee signature verifies over them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { env, MemKV, ROOT, sim } from './helpers'
import { runPreview } from '../functions/_lib/preview'
import { compile, requestBytes } from '../functions/_lib/nearai'
import { fingerprint } from '../functions/_lib/ledger'
import { parseAgg, totalKey } from '../functions/_lib/ledgerStore'
import { toNano } from '../functions/_lib/pricing'
import { sha256Hex } from '../src/game/chain/signature'

const GLM = 'z-ai/glm-5.3-flash'
const SIGNER = '0x3b753b4406613c5e70ae640508632b600424fa0c'
const load = (slug: string) => JSON.parse(readFileSync(join(ROOT, `vectors/nearai-real-z_ai_glm_5_3_flash-${slug}.json`), 'utf8'))

function replay(v: any) {
  const sent: Uint8Array[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/chat/completions')) { sent.push(init!.body as Uint8Array); return new Response(v.response_utf8) }
    if (url.includes('/v1/signature/')) return new Response(JSON.stringify(v.signature))
    return new Response('not here', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchFn, sent }
}

describe.each(['cactus-low', 'pigeon-low'])('recorded glm-5.3-flash compile: %s', (slug) => {
  const v = load(slug)
  it('the recorded request is the wasm build_request for glm (with "reasoning_effort":"low")', () => {
    expect(v.model).toBe(GLM)
    expect(sim().buildRequest(GLM, v.sentence)).toBe(v.request_utf8)
    expect(sha256Hex(new TextEncoder().encode(v.request_utf8))).toBe(v.request_sha256)
  })
  it('the worker sends the wasm bytes, and the recorded signature verifies over them', async () => {
    const { fetchFn, sent } = replay(v)
    const c = await compile(env({ NEARAI_API_KEY: 'k' }), sim(), GLM, v.sentence, fetchFn, async () => undefined)
    expect(new TextDecoder().decode(sent[0])).toBe(new TextDecoder().decode(requestBytes(sim(), GLM, v.sentence)))
    expect(c.signed.signing_address).toBe(SIGNER)
    expect(c.verification.signatureValid).toBe(true)
    expect(c.verification.responseSha256).toBe(v.response_sha256)
    expect(c.verification.requestSha256).toBe(v.request_sha256)
    expect(c.verification.verified).toBe(true)
    expect(c.usage).toEqual({ prompt_tokens: v.usage.prompt_tokens, completion_tokens: v.usage.completion_tokens })
  })
  it('a preview of it is charged exactly what NEAR AI billed', async () => {
    const e = env({ NEARAI_API_KEY: 'sk-vector' })
    const r = await runPreview({ env: e, sim: sim(), chain: null, fetchFn: replay(v).fetchFn }, v.sentence)
    expect(r.signer).toBe(SIGNER)
    expect(r.verified).toBe(true)
    expect(r.responseSha256).toBe(v.response_sha256)
    const t = parseAgg((e.TS_KV as MemKV).store.get(totalKey(fingerprint('sk-vector'))) as string)
    expect(t.n).toBe(toNano(v.usd))
  })
})
