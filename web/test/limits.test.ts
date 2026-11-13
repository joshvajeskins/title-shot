// KV-aware rate limits (1 write/sec/key, failed KV never a 500), global daily spend caps and the unknown-hash miss cache.
import { describe, expect, it } from 'vitest'
import { env, MemKV, recordedExchange, ctx, json, sim, archetypes } from './helpers'
import { CAPS, consume, enforce, KvUnavailable, resetRateMemory, RULES, spendCap, WRITE_GAP_MS } from '../functions/_lib/ratelimit'
import { cryFor, portraitFor } from '../functions/_lib/media'
import { runPreview } from '../functions/_lib/preview'
import { missKey, previewKey } from '../functions/_lib/lookup'
import { onRequest as previewApi } from '../functions/api/preview'
import { onRequest as stateApi } from '../functions/api/state'
import { onRequest as portraitApi } from '../functions/api/portrait/[hash]'
import { hashOf } from './fixtures'
import { getJson } from '../functions/_lib/cache'
import type { Chain } from '../functions/_lib/chain'

const T = 1_700_000_000_000
const day = (rule: { windowSec: number }, now = T) => Math.floor(now / 1000 / rule.windowSec)
const capKey = (c: { name: string; windowSec: number }) => `rl:${c.name}:all:${day(c, Date.now())}` // the endpoints use the real clock
const req = (ip = '7.7.7.7') => new Request('https://t.test/x', { headers: { 'cf-connecting-ip': ip } })
const down = (kv: MemKV, which: ('get' | 'put')[] = ['get', 'put']) => {
  if (which.includes('get')) kv.get = async () => { throw new Error('kv down') }
  if (which.includes('put')) kv.put = async () => { throw new Error('kv down') }
  return kv
}

/** A KV that refuses a second write to the same key within one second, like the real one (HTTP 429), on a fake clock. */
class OneWritePerSecondKV extends MemKV {
  last = new Map<string, number>()
  refused = 0
  clock = T
  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    const prev = this.last.get(key)
    if (prev !== undefined && this.clock - prev < 1000) { this.refused++; throw new Error('KV PUT failed: 429 Too Many Requests') }
    this.last.set(key, this.clock)
    return super.put(key, value)
  }
}

describe('counter writes respect the KV limit of one write per second per key', () => {
  it('120 sequential requests 50 ms apart (a lobby burst) are all counted and the KV never refuses a write', async () => {
    const kv = new OneWritePerSecondKV()
    let ok = 0
    for (let i = 0; i < 120; i++) {
      kv.clock = T + i * 50
      const r = await consume(kv, RULES.stateMin, '1.1.1.1', kv.clock)
      if (r.ok) ok++
    }
    expect(ok).toBe(120)
    expect(kv.refused).toBe(0)
    expect(kv.puts).toBeLessThanOrEqual(Math.ceil((120 * 50) / WRITE_GAP_MS) + 1) // 6 s of traffic: a handful of writes, not 120
    expect(kv.puts).toBeGreaterThanOrEqual(2)
  })
  it('the flushed count is what a cold isolate resumes from', async () => {
    const kv = new OneWritePerSecondKV()
    for (let i = 0; i < 5; i++) { kv.clock = T + i * 1200; await consume(kv, RULES.previewDay, 'ip', kv.clock) }
    resetRateMemory() // a different isolate
    kv.clock = T + 8000
    const r = await consume(kv, RULES.previewDay, 'ip', kv.clock)
    expect(r.count).toBe(6) // resumes from the 5 that were flushed, then counts this one
  })
  it('a parallel burst on one isolate is counted exactly while the KV sees one write', async () => {
    const kv = new OneWritePerSecondKV()
    const rs = await Promise.all(Array.from({ length: 50 }, () => consume(kv, RULES.previewMin, 'burst', T)))
    expect(rs.filter((r) => r.ok).length).toBe(12)
    expect(kv.refused).toBe(0)
    expect(kv.puts).toBe(1)
  })
})

describe('a failing counter store is never a 500', () => {
  it('paid endpoints fail closed: 429 { error, code: RATE_LIMITED } on a failed write and on a failed read', async () => {
    for (const which of [['put'], ['get'], ['get', 'put']] as ('get' | 'put')[][]) {
      const e = env()
      down(e.TS_KV as MemKV, which)
      const r = await previewApi(ctx(json('/api/preview', { sentence: 'a very polite kraken' }), e))
      expect(r.status, which.join()).toBe(429)
      expect(await r.json()).toMatchObject({ code: 'RATE_LIMITED', error: expect.any(String) })
      expect(r.headers.get('retry-after')).toBeTruthy()
    }
  })
  it('enforce rolls the failed increment back: the refused request is not charged', async () => {
    const kv = new MemKV()
    const put = kv.put.bind(kv)
    kv.put = async () => { throw new Error('kv down') }
    await expect(enforce(kv, RULES.guestIp, req(), 'x')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' })
    kv.put = put
    for (let i = 0; i < 3; i++) await enforce(kv, RULES.guestIp, req(), 'x') // all three of the day's guests are still available
    await expect(enforce(kv, RULES.guestIp, req(), 'x')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })
  it('consume throws KvUnavailable (not a raw error) so callers choose', async () => {
    await expect(consume(down(new MemKV()), RULES.cryGen, 'a', T)).rejects.toBeInstanceOf(KvUnavailable)
  })
  it('/api/state fails open: a dead KV never turns the lobby into an error from the limiter', async () => {
    const kv = down(new MemKV())
    await expect(enforce(kv, RULES.stateMin, req(), undefined, 'open')).resolves.toBeUndefined()
    const r = await stateApi(ctx(new Request('https://t.test/api/state'), { TS_KV: kv }))
    expect(r.status).not.toBe(429)
    expect((await r.clone().json() as { code?: string }).code).not.toBe('RATE_LIMITED')
  })
  it('/api/state still refuses a real flood (over the generous per-minute limit)', async () => {
    const kv = new MemKV()
    const rs = await Promise.all(Array.from({ length: 620 }, () => consume(kv, RULES.stateMin, '3.3.3.3', T)))
    expect(rs.filter((r) => !r.ok).length).toBe(20)
  })
})

describe('global daily caps (all callers together)', () => {
  it('the caps are 600 uncached compiles, 200 portraits and 300 battle cries per day', () => {
    expect([CAPS.previewCompile.limit, CAPS.portraitGen.limit, CAPS.cryGen.limit]).toEqual([600, 200, 300])
    expect([CAPS.previewCompile.windowSec, CAPS.portraitGen.windowSec, CAPS.cryGen.windowSec]).toEqual([86_400, 86_400, 86_400])
  })
  it('over the cap is 429 { code: DAILY_CAP }; the cap resets with the day bucket', async () => {
    const kv = new MemKV()
    for (let i = 0; i < 300; i++) await spendCap(kv, CAPS.cryGen, T)
    await expect(spendCap(kv, CAPS.cryGen, T)).rejects.toMatchObject({ status: 429, code: 'DAILY_CAP' })
    await expect(spendCap(kv, CAPS.cryGen, T + 86_400_000)).resolves.toBeUndefined()
  })
  it('a dead counter store refuses spend instead of leaving it unmetered', async () => {
    await expect(spendCap(down(new MemKV()), CAPS.portraitGen, T)).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' })
  })

  const ex = () => recordedExchange(sim(), 'Qwen/Qwen3.8-27B', 'a pigeon with a law degree', JSON.stringify(archetypes()[0]!.raw))
  it('/api/preview: the 601st uncached compile of the day is DAILY_CAP and never reaches the AI; cached and canonical results still serve', async () => {
    const kv = new MemKV()
    await kv.put(capKey(CAPS.previewCompile), '600')
    const e = { TS_KV: kv, NEARAI_API_KEY: 'k' }
    const calls: string[] = []
    const fetchFn = (async (u: string) => { calls.push(u); return new Response('{}') }) as unknown as typeof fetch
    await expect(runPreview({ env: e, sim: sim(), chain: null, fetchFn }, 'a pigeon with a law degree')).rejects.toMatchObject({ status: 429, code: 'DAILY_CAP' })
    expect(calls).toEqual([])
    const hit = { spec: { name: 'Cached' }, canonical: false, portrait: '/p', hash: 'h' }
    await kv.put(previewKey(hashOf('a pigeon with a law degree')), JSON.stringify({ result: hit, fighter: {} }))
    expect(await runPreview({ env: e, sim: sim(), chain: null, fetchFn }, 'a pigeon with a law degree')).toMatchObject({ spec: { name: 'Cached' } })
  })
  it('/api/preview under the cap counts exactly one unit per uncached compile', async () => {
    const kv = new MemKV()
    const e = ex()
    const fetchFn = (async (u: string) => (u.includes('/v1/signature/') ? new Response(JSON.stringify({ text: e.text, signature: e.signature, signing_address: e.signing_address, signing_algo: 'ecdsa', signature_kind: e.kind })) : new Response(e.response))) as unknown as typeof fetch
    await runPreview({ env: { TS_KV: kv, NEARAI_API_KEY: 'k' }, sim: sim(), chain: null, fetchFn }, 'a pigeon with a law degree')
    expect(Number(await kv.get(capKey(CAPS.previewCompile)))).toBe(1)
  })
  const HASH = '0a1b2c3d' + 'ee'.repeat(28)
  const fighterRow = { fighter: { look: 'a plump pigeon in a tiny barrister wig', cry: 'I object! Also, crumbs.', school: 'MIND', style: 'TACTICIAN', name: 'Coo' } }
  it('portrait and cry generation stop at their daily caps with DAILY_CAP and no upstream call', async () => {
    for (const [fn, cap, extra] of [[portraitFor, CAPS.portraitGen, {}], [cryFor, CAPS.cryGen, { ELEVENLABS_API_KEY: 'k' }]] as const) {
      const kv = new MemKV()
      await kv.put(previewKey(HASH), JSON.stringify(fighterRow))
      await kv.put(capKey(cap), String(cap.limit))
      const calls: string[] = []
      const fetchFn = (async (u: string) => { calls.push(u); return new Response('x', { status: 500 }) }) as unknown as typeof fetch
      await expect(fn({ TS_KV: kv, NEARAI_API_KEY: 'k', ...extra }, null, HASH, async () => undefined, fetchFn)).rejects.toMatchObject({ status: 429, code: 'DAILY_CAP' })
      expect(calls).toEqual([])
    }
  })
})

describe('unknown fighter hashes are cached for 60 s', () => {
  const HASH = 'ab'.repeat(32)
  const stubChain = (calls: string[], throws = false) => ({ id: 'titleshot.testnet', fighter: async (h: string) => { calls.push(h); if (throws) throw new Error('rpc down'); return null } }) as unknown as Chain
  it('the second ask for an unknown hash is answered from KV without another chain read; the marker lives 60 s', async () => {
    const kv = new MemKV()
    const puts: { key: string; ttl?: number }[] = []
    const put = kv.put.bind(kv)
    kv.put = async (k: string, v: string | ArrayBuffer, o?: { expirationTtl?: number }) => { puts.push({ key: k, ttl: o?.expirationTtl }); return put(k, v) }
    const calls: string[] = []
    for (let i = 0; i < 3; i++) await expect(portraitFor({ TS_KV: kv }, stubChain(calls), HASH, async () => undefined)).rejects.toMatchObject({ status: 404, code: 'NO_FIGHTER' })
    expect(calls.length).toBe(1)
    expect(puts.find((p) => p.key === missKey('portrait', HASH))?.ttl).toBe(60)
  })
  it('an RPC outage is not remembered as "no such fighter"', async () => {
    const kv = new MemKV()
    const calls: string[] = []
    for (let i = 0; i < 2; i++) await expect(portraitFor({ TS_KV: kv }, stubChain(calls, true), HASH, async () => undefined)).rejects.toMatchObject({ code: 'NO_FIGHTER' })
    expect(calls.length).toBe(2)
    expect(await getJson(kv, missKey('portrait', HASH))).toBeNull()
  })
  it('a fresh preview of that sentence clears the marker so the portrait can be made at once', async () => {
    const kv = new MemKV()
    const sentence = 'a pigeon with a law degree'
    const hash = hashOf(sentence)
    await kv.put(missKey('portrait', hash), '1')
    const e = recordedExchange(sim(), 'Qwen/Qwen3.8-27B', sentence, JSON.stringify(archetypes()[0]!.raw))
    const fetchFn = (async (u: string) => (u.includes('/v1/signature/') ? new Response(JSON.stringify({ text: e.text, signature: e.signature, signing_address: e.signing_address, signing_algo: 'ecdsa', signature_kind: e.kind })) : new Response(e.response))) as unknown as typeof fetch
    await runPreview({ env: { TS_KV: kv, NEARAI_API_KEY: 'k' }, sim: sim(), chain: null, fetchFn }, sentence)
    expect(await kv.get(missKey('portrait', hash))).toBeNull()
  })
  it('the endpoint returns the cached 404 in the standard { error, code } shape', async () => {
    const kv = new MemKV()
    await kv.put(missKey('portrait', HASH), '1')
    const r = await portraitApi(ctx(new Request('https://t.test/x', { headers: { 'cf-connecting-ip': '4.4.4.4' } }), { TS_KV: kv }, { hash: HASH }))
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ code: 'NO_FIGHTER' })
  })
})
