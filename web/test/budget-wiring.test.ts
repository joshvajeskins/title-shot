// The ledger wired into the paid paths: preview (FORGE_CLOSED), portrait (PORTRAIT_BUDGET), opener, contract forges, /api/state.
import { describe, expect, it } from 'vitest'
import { archetypes, env, MemKV, recordedExchange, sim } from './helpers'
import { runPreview } from '../functions/_lib/preview'
import { portraitFor } from '../functions/_lib/media'
import { previewKey } from '../functions/_lib/lookup'
import { writeOpener } from '../functions/_lib/opener'
import { forgeChargeStep, forgeSeenKey } from '../functions/_lib/tickForge'
import { forgeStatus } from '../functions/_lib/ledgerStatus'
import { fingerprint } from '../functions/_lib/ledger'
import { parseAgg, totalKey } from '../functions/_lib/ledgerStore'
import { toNano } from '../functions/_lib/pricing'
import type { Env } from '../functions/_lib/env'
import type { StepLog, TickDeps } from '../functions/_lib/tickTypes'

const GLM = 'z-ai/glm-5.3-flash'
const KEY = 'sk-wiring-test-key'
const SENTENCE = 'a pigeon with a law degree'
const HASH = '0a1b2c3d' + 'ee'.repeat(28)
const spent = (kv: MemKV) => parseAgg((kv.store.get(totalKey(fingerprint(KEY))) as string) ?? null)

function nearAi(opts: { chat?: () => Response; image?: () => Response } = {}) {
  const ex = recordedExchange(sim(), GLM, SENTENCE, JSON.stringify(archetypes()[0]!.raw))
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path === '/v1/chat/completions') return opts.chat ? opts.chat() : new Response(ex.response)
    if (path.startsWith('/v1/signature/')) return new Response(JSON.stringify({ text: ex.text, signature: ex.signature, signing_address: ex.signing_address, signing_algo: 'ecdsa', signature_kind: 'provider_tee' }))
    if (path === '/v1/images/generations') return opts.image ? opts.image() : new Response(JSON.stringify({ id: 'img-1', data: [{ b64_json: btoa(String.fromCharCode(0x89, 0x50, ...Array.from({ length: 200 }, (_, i) => i))) }] }))
    return new Response('not here', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}
const e = (over: Partial<Env> = {}): Env => env({ NEARAI_API_KEY: KEY, ...over })
const preview = (en: Env, fetchFn: typeof fetch, who: 'public' | 'owner' = 'public') => runPreview({ env: en, sim: sim(), chain: null, fetchFn, who }, SENTENCE)

describe('preview through the ledger', () => {
  it('settles to the usage in the response (1500 in, 120 out = $0.00018)', async () => {
    const en = e()
    await preview(en, nearAi().fetchFn)
    expect(spent(en.TS_KV as MemKV)).toMatchObject({ n: toNano(0.00018), pub: toNano(0.00018), calls: 1, kinds: { compile: toNano(0.00018) } })
  })
  it('budget used up: 503 FORGE_CLOSED and NEAR AI is never called', async () => {
    const api = nearAi()
    await expect(preview(e({ NEARAI_BUDGET_USD: '0' }), api.fetchFn)).rejects.toMatchObject({ status: 503, code: 'FORGE_CLOSED' })
    expect(api.calls).not.toContain('/v1/chat/completions')
  })
  it('public caps used up: public traffic is refused, owner traffic (tick secret) still compiles', async () => {
    const en = e({ NEARAI_PUBLIC_DAILY_USD: '0.0001' })
    await expect(preview(en, nearAi().fetchFn)).rejects.toMatchObject({ status: 503, code: 'FORGE_CLOSED' })
    await expect(preview(en, nearAi().fetchFn, 'owner')).resolves.toMatchObject({ canonical: false })
    expect(spent(en.TS_KV as MemKV)).toMatchObject({ n: toNano(0.00018), pub: 0 })
  })
  it('an upstream error status is not billed; no answer at all is charged at worst case', async () => {
    const a = e()
    await expect(preview(a, nearAi({ chat: () => new Response('boom', { status: 500 }) }).fetchFn)).rejects.toMatchObject({ code: 'AI_STATUS' })
    expect(spent(a.TS_KV as MemKV).n).toBe(0)
    const b = e()
    const down = (async (url: string) => { if (url.endsWith('/v1/models')) return new Response('', { status: 503 }); throw new TypeError('socket') }) as unknown as typeof fetch
    await expect(preview(b, down)).rejects.toMatchObject({ code: 'AI_UPSTREAM' })
    expect(spent(b.TS_KV as MemKV).n).toBe(toNano(0.00064))
  })
  it('the stand-in referee (staging, no key) never touches the ledger', async () => {
    const en = env({ COMPILER_MODE: 'standin', NEARAI_BUDGET_USD: '0', STANDIN_SIGNER_KEY: 'ab'.repeat(32) })
    await expect(runPreview({ env: en, sim: sim(), chain: null, fetchFn: nearAi().fetchFn }, 'a skeleton who is late for work')).resolves.toMatchObject({ compiler: 'standin' })
  })
})

describe('portraits through the ledger', () => {
  const withFighter = (en: Env) => (en.TS_KV as MemKV).put(previewKey(HASH), JSON.stringify({ fighter: { look: 'a plump pigeon in a tiny barrister wig', cry: 'x', school: 'MIND', style: 'TACTICIAN', name: 'Coo' } }))
  const open = async () => undefined
  it('budget used up: 404 PORTRAIT_BUDGET, no image call, and not remembered as "no portrait"', async () => {
    const en = e({ NEARAI_BUDGET_USD: '0.005' })
    await withFighter(en)
    const api = nearAi()
    await expect(portraitFor(en, null, HASH, open, api.fetchFn, { wait: async () => undefined })).rejects.toMatchObject({ status: 404, code: 'PORTRAIT_BUDGET' })
    expect(api.calls).not.toContain('/v1/images/generations')
    en.NEARAI_BUDGET_USD = '1'
    const img = await portraitFor(en, null, HASH, open, api.fetchFn, { wait: async () => undefined })
    expect(img.type).toBe('image/png')
    expect(spent(en.TS_KV as MemKV)).toMatchObject({ n: toNano(0.012), kinds: { portrait: toNano(0.012) } })
  })
  it('a failed generation (error status) is free', async () => {
    const en = e()
    await withFighter(en)
    await expect(portraitFor(en, null, HASH, open, nearAi({ image: () => new Response('no', { status: 500 }) }).fetchFn)).rejects.toMatchObject({ code: 'NO_PORTRAIT' })
    expect(spent(en.TS_KV as MemKV).n).toBe(0)
  })
})

describe('Vance opener through the ledger', () => {
  it('asks GLM with low reasoning effort and settles its usage; a closed ledger means the curated list, no call', async () => {
    const bodies: any[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/v1/chat/completions')) return new Response('', { status: 404 })
      bodies.push(JSON.parse(String(init!.body)))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'a walrus who refuses to leave the sauna' } }], usage: { prompt_tokens: 90, completion_tokens: 12 } }))
    }) as unknown as typeof fetch
    const en = e()
    expect(await writeOpener(en, GLM, { seasonId: 3, recent: [] }, fetchFn)).toEqual({ sentence: 'a walrus who refuses to leave the sauna', source: 'nearai' })
    expect(bodies[0]).toMatchObject({ model: GLM, reasoning_effort: 'low', max_tokens: 60 })
    expect(spent(en.TS_KV as MemKV)).toMatchObject({ n: toNano(90 * 0.08e-6 + 12 * 0.5e-6), pub: 0, kinds: { opener: toNano(90 * 0.08e-6 + 12 * 0.5e-6) } })
    const shut = e({ NEARAI_BUDGET_USD: '0' })
    expect((await writeOpener(shut, GLM, { seasonId: 3, recent: [] }, fetchFn)).source).toBe('fallback')
    expect(bodies.length).toBe(1)
  })
})

describe('the tick charges contract forges from get_compile_caps().used', () => {
  const deps = (en: Env, caps: { used: number }) => ({
    env: en, fetchFn: nearAi().fetchFn, now: () => Date.UTC(2026, 10, 14),
    chain: { id: 'titleshot.testnet', compileCaps: async () => ({ daily: 60, total: 250, today: 0, day: 0, ...caps }), config: async () => ({ model_id: GLM }) },
  }) as unknown as TickDeps
  it('charges new compiles at the worst case (0.00064) as public forge spend, once each, and a reset counter starts over', async () => {
    const en = e()
    const caps = { used: 5 }
    const steps: StepLog[] = []
    const d = deps(en, caps)
    await forgeChargeStep(d, (s) => steps.push(s))
    expect(spent(en.TS_KV as MemKV)).toMatchObject({ n: 5 * toNano(0.00064), pub: 5 * toNano(0.00064), calls: 5, kinds: { forge: 5 * toNano(0.00064) } })
    await forgeChargeStep(d, (s) => steps.push(s)) // nothing new
    caps.used = 7
    await forgeChargeStep(d, (s) => steps.push(s))
    caps.used = 1 // reset_compile_counter (key rotation): everything since the reset is new
    await forgeChargeStep(d, (s) => steps.push(s))
    expect(spent(en.TS_KV as MemKV).calls).toBe(8)
    expect(steps.map((s) => s.detail)).toEqual(['5 contract compiles charged at worst case', '2 contract compiles charged at worst case', '1 contract compile charged at worst case'])
    expect((en.TS_KV as MemKV).store.get(forgeSeenKey(d, fingerprint(KEY)))).toBe('1')
  })
  it('no key (stand-in staging): nothing to charge', async () => {
    const en = env()
    await forgeChargeStep(deps(en, { used: 9 }), () => undefined)
    expect([...(en.TS_KV as MemKV).store.keys()].some((k) => k.includes('ledger:'))).toBe(false)
  })
})

describe('/api/state forge and portraits fields', () => {
  it('open with a key and room; no key: stand-in open, otherwise closed with no_key', async () => {
    expect(await forgeStatus(e(), GLM)).toMatchObject({ forge: { open: true, reason: null, spentUsd: 0, budgetUsd: 2.5, publicLeftUsd: 0.05 }, portraits: { open: true } })
    expect(await forgeStatus(env({ COMPILER_MODE: 'standin' }), GLM)).toMatchObject({ forge: { open: true, reason: null }, portraits: { open: false } })
    expect(await forgeStatus(env(), GLM)).toMatchObject({ forge: { open: false, reason: 'no_key', publicLeftUsd: 0 }, portraits: { open: false } })
    expect(await forgeStatus(e({ NEARAI_BUDGET_USD: '0' }), GLM)).toMatchObject({ forge: { open: false, reason: 'budget', resetsAt: null } })
  })
})
