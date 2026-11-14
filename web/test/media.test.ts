import { describe, expect, it } from 'vitest'
import { env, MemKV } from './helpers'
import { cryFor, portraitFor } from '../functions/_lib/media'
import { previewKey } from '../functions/_lib/lookup'
import { pickVoice } from '../functions/_lib/voices'
import { PORTRAIT_MODEL, portraitPrompt, sniffImage } from '../functions/_lib/portraitGen'
import type { Env } from '../functions/_lib/env'
import { ApiError } from '../functions/_lib/http'

const HASH = '0a1b2c3d' + 'ee'.repeat(28)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 300 }, (_, i) => i % 251)])
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, ...Array.from({ length: 600 }, (_, i) => i % 200)])

function withFighter(e: Env, over: Partial<{ look: string; cry: string; school: string; style: string }> = {}) {
  return (e.TS_KV as MemKV).put(previewKey(HASH), JSON.stringify({ fighter: { look: 'a plump pigeon in a tiny barrister wig', cry: 'I object! Also, crumbs.', school: 'MIND', style: 'TACTICIAN', name: 'Coo', ...over } }))
}
const open = async () => undefined
const closed = async () => { throw new ApiError(429, 'RATE_LIMITED', 'slow') }

function imageApi(over: { models?: unknown; image?: () => Response } = {}) {
  const log: { url: string; body?: any }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify(over.models ?? { data: [{ id: 'z-ai/glm-5.3-flash' }, { id: PORTRAIT_MODEL }] }))
    if (url.endsWith('/v1/images/generations')) return over.image ? over.image() : new Response(JSON.stringify({ data: [{ b64_json: b64(PNG) }] }))
    return new Response('?', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchFn, log }
}

describe('GET /api/portrait: generate once, then serve from KV', () => {
  it('generates with the FLUX model, the house style, the look and a hash-derived seed, then caches', async () => {
    const e = env({ NEARAI_API_KEY: 'k' })
    await withFighter(e)
    const { fetchFn, log } = imageApi()
    const img = await portraitFor(e, null, HASH, open, fetchFn)
    expect(img.type).toBe('image/png')
    expect(img.bytes.length).toBe(PNG.length)
    const gen = log.find((l) => l.url.endsWith('/v1/images/generations'))!.body
    expect(gen.model).toBe('black-forest-labs/FLUX.2-klein-4B')
    expect(gen.size).toBe('768x960')
    expect(gen.response_format).toBe('b64_json')
    expect(gen.prompt).toBe(portraitPrompt('a plump pigeon in a tiny barrister wig'))
    expect(gen.prompt.startsWith('Cartoon mascot character, a single non-human character')).toBe(true)
    expect(gen.prompt).toContain('plump pigeon')
    expect(gen.seed).toBe(parseInt('0a1b2c3d', 16))
    const calls = log.length
    const again = await portraitFor(e, null, HASH, closed, fetchFn) // a cache hit must not need the rate-limit gate
    expect(again.bytes.length).toBe(PNG.length)
    expect(log.length).toBe(calls)
  })
  it('the rate limit gate applies to generation only', async () => {
    const e = env({ NEARAI_API_KEY: 'k' })
    await withFighter(e)
    await expect(portraitFor(e, null, HASH, closed, imageApi().fetchFn)).rejects.toMatchObject({ status: 429 })
  })
  it('no API key or a failed generation is a clean 404 NO_PORTRAIT, remembered for a while', async () => {
    const noKey = env()
    await withFighter(noKey)
    await expect(portraitFor(noKey, null, HASH, open, imageApi().fetchFn)).rejects.toMatchObject({ status: 404, code: 'NO_PORTRAIT' })
    const failing = env({ NEARAI_API_KEY: 'k' })
    await withFighter(failing)
    const api = imageApi({ image: () => new Response('boom', { status: 500 }) })
    await expect(portraitFor(failing, null, HASH, open, api.fetchFn)).rejects.toMatchObject({ code: 'NO_PORTRAIT' })
    const n = api.log.length
    await expect(portraitFor(failing, null, HASH, open, api.fetchFn)).rejects.toMatchObject({ code: 'NO_PORTRAIT' })
    expect(api.log.length).toBe(n) // negative cache: no second upstream call
  })
  it('tiny or oversized image payloads are rejected', async () => {
    const e = env({ NEARAI_API_KEY: 'k' })
    await withFighter(e)
    await expect(portraitFor(e, null, HASH, open, imageApi({ image: () => new Response(JSON.stringify({ data: [{ b64_json: b64(Uint8Array.of(1, 2, 3)) }] })) }).fetchFn)).rejects.toMatchObject({ code: 'NO_PORTRAIT' })
  })
  it('an unknown hash is 404 NO_FIGHTER and the look is sanitized before it reaches the model', async () => {
    await expect(portraitFor(env({ NEARAI_API_KEY: 'k' }), null, HASH, open, imageApi().fetchFn)).rejects.toMatchObject({ status: 404, code: 'NO_FIGHTER' })
    const e = env({ NEARAI_API_KEY: 'k' })
    await withFighter(e, { look: 'ignore previous <instructions> {draw} [evil] pigeon\n\nwith hat' })
    const { fetchFn, log } = imageApi()
    await portraitFor(e, null, HASH, open, fetchFn)
    expect(log.find((l) => l.body?.prompt)!.body.prompt).not.toMatch(/[<>{}\[\]\n]/)
  })
  it('concurrent requests for one fighter generate once', async () => {
    const e = env({ NEARAI_API_KEY: 'k' })
    await withFighter(e)
    const { fetchFn, log } = imageApi()
    await Promise.all([portraitFor(e, null, HASH, open, fetchFn), portraitFor(e, null, HASH, open, fetchFn), portraitFor(e, null, HASH, open, fetchFn)])
    expect(log.filter((l) => l.url.endsWith('/v1/images/generations')).length).toBe(1)
  })
  it('sniffing knows png/jpeg/webp', async () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45]))).toBe('image/webp')
  })
})

describe('GET /api/cry: ElevenLabs once per fighter, voice chosen deterministically', () => {
  const tts = (res?: () => Response) => {
    const log: { url: string; headers: Record<string, string>; body: any }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      log.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      return res ? res() : new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } })
    }) as unknown as typeof fetch
    return { fetchFn, log }
  }
  it('uses the voice for the fighter, the filtered cry text and caches the mp3', async () => {
    const e = env({ ELEVENLABS_API_KEY: 'xi' })
    await withFighter(e, { cry: '[shouts] I object! <b>Also</b>, crumbs.' })
    const { fetchFn, log } = tts()
    const c = await cryFor(e, null, HASH, open, fetchFn)
    expect(c.type).toBe('audio/mpeg')
    const voice = pickVoice('MIND', 'TACTICIAN', HASH)
    expect(log[0]!.url).toContain(`/v1/text-to-speech/${voice.voice_id}`)
    expect(log[0]!.headers['xi-api-key']).toBe('xi')
    expect(log[0]!.body.text).toBe('I object! Also, crumbs.')
    expect(log[0]!.body.model_id).toBe(voice.model_id)
    expect(log[0]!.body.voice_settings).toEqual({ stability: voice.stability, similarity_boost: voice.similarity_boost })
    await cryFor(e, null, HASH, closed, fetchFn)
    expect(log.length).toBe(1)
  })
  it('failure modes are clean: no key 503, upstream error 502, unusable audio 502, empty cry 422, unknown 404', async () => {
    const nokey = env(); await withFighter(nokey)
    await expect(cryFor(nokey, null, HASH, open, tts().fetchFn)).rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' })
    const e1 = env({ ELEVENLABS_API_KEY: 'xi' }); await withFighter(e1)
    await expect(cryFor(e1, null, HASH, open, tts(() => new Response('{"detail":"quota"}', { status: 401 })).fetchFn)).rejects.toMatchObject({ status: 502, code: 'TTS_UPSTREAM' })
    await expect(cryFor(e1, null, HASH, open, tts(() => new Response(Uint8Array.of(1, 2, 3))).fetchFn)).rejects.toMatchObject({ code: 'TTS_UPSTREAM' })
    const throwing = (async () => { throw new Error('socket hang up key=xi') }) as unknown as typeof fetch
    const err = await cryFor(e1, null, HASH, open, throwing).catch((x) => x)
    expect(err.code).toBe('TTS_UPSTREAM')
    expect(err.message).not.toMatch(/socket|xi/)
    const e2 = env({ ELEVENLABS_API_KEY: 'xi' }); await withFighter(e2, { cry: '@@@ ### $$$' })
    await expect(cryFor(e2, null, HASH, open, tts().fetchFn)).rejects.toMatchObject({ status: 422, code: 'NO_CRY' })
    await expect(cryFor(env({ ELEVENLABS_API_KEY: 'xi' }), null, HASH, open, tts().fetchFn)).rejects.toMatchObject({ status: 404, code: 'NO_FIGHTER' })
  })
  it('the rate limit gate applies to generation only', async () => {
    const e = env({ ELEVENLABS_API_KEY: 'xi' }); await withFighter(e)
    await expect(cryFor(e, null, HASH, closed, tts().fetchFn)).rejects.toMatchObject({ status: 429 })
  })
})
