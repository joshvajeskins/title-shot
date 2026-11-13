import { describe, expect, it } from 'vitest'
import { archetypes, env, MemKV, recordedExchange, sim, TEST_ADDRESS, signEip191 } from './helpers'
import { fighter } from './fixtures'
import { runPreview } from '../functions/_lib/preview'
import { compile, fetchSignature, requestBytes } from '../functions/_lib/nearai'
import type { Chain } from '../functions/_lib/chain'
import { ApiError } from '../functions/_lib/http'
import { sha256Hex } from '../src/game/chain/signature'

const MODEL = 'Qwen/Qwen3.8-27B'
const SENTENCE = 'a pigeon with a law degree'
const content = (over: Record<string, unknown> = {}) => JSON.stringify({ ...archetypes()[0]!.raw, ...over })

interface Script { chat?: (body: Uint8Array) => Response; sig?: (n: number) => Response; calls: string[] }
function nearAi(ex: ReturnType<typeof recordedExchange>, s: Partial<Script> = {}): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  let sigN = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
    if (url.includes('/v1/chat/completions')) {
      const body = init!.body as Uint8Array
      expect(body).toBeInstanceOf(Uint8Array)
      expect(sha256Hex(body)).toBe(sha256Hex(ex.req)) // the exact bytes the contract rebuilds
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer test-key')
      return s.chat ? s.chat(body) : new Response(ex.response, { status: 200 })
    }
    if (url.includes('/v1/signature/')) {
      sigN++
      if (s.sig) return s.sig(sigN)
      return new Response(JSON.stringify({ text: ex.text, signature: ex.signature, signing_address: ex.signing_address, signing_algo: 'ecdsa', signature_kind: ex.kind }))
    }
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}
const e = () => env({ NEARAI_API_KEY: 'test-key' })
const noWait = async () => undefined

describe('preview compile = the same signed bytes as the paid forge', () => {
  it('returns the normalized spec, the signature evidence and caches it', async () => {
    const ex = recordedExchange(sim(), MODEL, SENTENCE, content())
    const { fetchFn, calls } = nearAi(ex)
    const env1 = e()
    const r = await runPreview({ env: env1, sim: sim(), chain: null, fetchFn }, '  a  pigeon with a law degree ')
    expect(r.canonical).toBe(false)
    expect(r.verified).toBe(true)
    expect(r.signer).toBe(TEST_ADDRESS)
    expect(r.spec.name).toBe('Counselor Coo')
    expect(r.spec.moves.map((m) => m.id)).toEqual(['brain_freeze', 'hex_gaze', 'claw_swipe'])
    expect(r.requestSha256).toBe(sha256Hex(ex.req))
    expect(r.raw).toBe(content())
    expect(r.signature).toMatchObject({ text: ex.text, kind: 'provider_tee', signing_address: TEST_ADDRESS })
    expect(r.portrait).toBe(`/api/portrait/${r.hash}`)
    const n = calls.length
    const again = await runPreview({ env: env1, sim: sim(), chain: null, fetchFn }, SENTENCE)
    expect(again).toEqual(r)
    expect(calls.length).toBe(n) // served from the KV cache
  })
  it('works for a gateway-kind signature too', async () => {
    const ex = recordedExchange(sim(), MODEL, SENTENCE, content(), 'gateway')
    const r = await runPreview({ env: e(), sim: sim(), chain: null, fetchFn: nearAi(ex).fetchFn }, SENTENCE)
    expect(r.verified).toBe(true)
    expect(r.signature!.kind).toBe('gateway')
  })
  it('a signature over different bytes is reported as unverified, not hidden', async () => {
    const ex = recordedExchange(sim(), MODEL, SENTENCE, content())
    const bad = { ...ex, signature: signEip191('some other text') }
    const r = await runPreview({ env: e(), sim: sim(), chain: null, fetchFn: nearAi(bad).fetchFn }, SENTENCE)
    expect(r.verified).toBe(false)
  })
  it('the model refusing the sentence is 422 REFUSED', async () => {
    const ex = recordedExchange(sim(), MODEL, SENTENCE, content({ verdict: 'refused', name: 'Refused' }))
    await expect(runPreview({ env: e(), sim: sim(), chain: null, fetchFn: nearAi(ex).fetchFn }, SENTENCE)).rejects.toMatchObject({ status: 422, code: 'REFUSED' })
  })
  it('an invalid fighter (unknown move, duplicate move, broken json) is 422 BAD_COMPILE', async () => {
    for (const raw of [content({ moves: [{ id: 'nope', label: 'x' }, { id: 'hex_gaze', label: 'y' }, { id: 'claw_swipe', label: 'z' }] }), content({ moves: [{ id: 'hex_gaze', label: 'x' }, { id: 'hex_gaze', label: 'y' }, { id: 'claw_swipe', label: 'z' }] }), '{"verdict":"ok"']) {
      const ex = recordedExchange(sim(), MODEL, SENTENCE, raw)
      await expect(runPreview({ env: e(), sim: sim(), chain: null, fetchFn: nearAi(ex).fetchFn }, SENTENCE)).rejects.toMatchObject({ status: 422, code: 'BAD_COMPILE' })
    }
  })
  it('an already forged sentence returns the final spec without calling NEAR AI', async () => {
    const f = fighter(0)
    const chain = { fighterBySentence: async () => f, config: async () => ({ model_id: MODEL }) } as unknown as Chain
    const fetchFn = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    const r = await runPreview({ env: e(), sim: sim(), chain, fetchFn }, SENTENCE)
    expect(r.canonical).toBe(true)
    expect(r.spec.name).toBe(f.spec.name)
    expect(r.signer).toBe(f.signer)
    expect(r.portrait).toBe('/art/fighter-pigeon.webp')
  })
  it('uses the contract configured model id for the request bytes', async () => {
    const ex = recordedExchange(sim(), 'other/model-7', SENTENCE, content())
    const chain = { fighterBySentence: async () => null, config: async () => ({ model_id: 'other/model-7' }) } as unknown as Chain
    const r = await runPreview({ env: e(), sim: sim(), chain, fetchFn: nearAi(ex).fetchFn }, SENTENCE)
    expect(r.verified).toBe(true)
  })
})

describe('preview upstream failures are clean ApiErrors, never raw errors', () => {
  const run = (ex: ReturnType<typeof recordedExchange>, s: Partial<Script>) => runPreview({ env: e(), sim: sim(), chain: null, fetchFn: nearAi(ex, s).fetchFn }, SENTENCE)
  const ex = recordedExchange(sim(), MODEL, SENTENCE, content())
  it('no API key: 503 AI_UNAVAILABLE', async () => {
    await expect(runPreview({ env: env(), sim: sim(), chain: null, fetchFn: nearAi(ex).fetchFn }, SENTENCE)).rejects.toMatchObject({ status: 503, code: 'AI_UNAVAILABLE' })
  })
  it('NEAR AI 500: 502 AI_STATUS', async () => { await expect(run(ex, { chat: () => new Response('boom secret-stack', { status: 500 }) })).rejects.toMatchObject({ status: 502, code: 'AI_STATUS' }) })
  it('network failure: 502 AI_UPSTREAM without the raw message', async () => {
    const fetchFn = (async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.1:443 token=abc') }) as unknown as typeof fetch
    const err = await runPreview({ env: e(), sim: sim(), chain: null, fetchFn }, SENTENCE).catch((x) => x)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 502, code: 'AI_UPSTREAM' })
    expect(err.message).not.toMatch(/ECONN|token|10\.0/)
  })
  it('a response with no id, null content (reasoning model) or non-JSON is 502 AI_BAD_RESPONSE', async () => {
    for (const body of [JSON.stringify({ choices: [{ message: { content: 'x' } }] }), JSON.stringify({ id: 'abc', choices: [{ message: { content: null } }] }), 'not json', JSON.stringify({ id: '../../x', choices: [{ message: { content: 'x' } }] })]) {
      await expect(run(ex, { chat: () => new Response(body) })).rejects.toMatchObject({ status: 502, code: 'AI_BAD_RESPONSE' })
    }
  })
  it('the signature endpoint is retried on 404 and then succeeds', async () => {
    const { fetchFn, calls } = nearAi(ex, { sig: (n) => (n < 3 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ text: ex.text, signature: ex.signature, signing_address: ex.signing_address, signing_algo: 'ecdsa', signature_kind: 'provider_tee' }))) })
    const c = await compile(e(), sim(), MODEL, SENTENCE, fetchFn, noWait)
    expect(c.verification.verified).toBe(true)
    expect(calls.filter((x) => x.includes('/v1/signature/')).length).toBe(3)
  })
  it('a signature that never arrives is 502 AI_NO_SIGNATURE after five tries; error_code bodies are not signatures', async () => {
    const calls: string[] = []
    const fetchFn = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ error_code: 'NOT_READY' })) }) as unknown as typeof fetch
    await expect(fetchSignature(e(), 'chatcmpl-1', MODEL, fetchFn, noWait)).rejects.toMatchObject({ code: 'AI_NO_SIGNATURE' })
    expect(calls.length).toBe(5)
    expect(calls[4]).toContain('model=')
    expect(calls[0]).not.toContain('model=')
  })
  it('the request body is prefix + escaped sentence + suffix even for hostile sentences', () => {
    const s = sim()
    const body = new TextDecoder().decode(requestBytes(s, MODEL, 'a "quoted" \\ back\nslash 🥊'))
    expect(JSON.parse(body).messages[1].content).toBe('Sentence: a "quoted" \\ back\nslash 🥊')
  })
  it('KV unavailable never reaches the AI: the uncached compile is refused with 429 RATE_LIMITED (spend stays metered), not a 500', async () => {
    const kv = new MemKV()
    kv.get = async () => { throw new Error('kv down') }
    kv.put = async () => { throw new Error('kv down') }
    const net = nearAi(ex)
    await expect(runPreview({ env: { TS_KV: kv, NEARAI_API_KEY: 'test-key' }, sim: sim(), chain: null, fetchFn: net.fetchFn }, SENTENCE)).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' })
    expect(net.calls).toEqual([])
  })
})
