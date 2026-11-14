// Portrait generation against the recorded NEAR AI vector (vectors/portrait-cactus-v2.{png,json}): the v2 prompt, the seed from
// sha256(sentence), FLUX.2-klein at 768x960, and the provider_tee signature stored for /api/portrait/:hash/meta.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ctx, env, MemKV, ROOT } from './helpers'
import { portraitFor, portraitMetaKey } from '../functions/_lib/media'
import { previewKey } from '../functions/_lib/lookup'
import { PORTRAIT_MODEL, portraitPrompt, portraitSeed, type PortraitMeta } from '../functions/_lib/portraitGen'
import { sentenceHash } from '../src/game/chain/views'
import { recoverAddress, sha256Hex } from '../src/game/chain/signature'
import { onRequest as meta } from '../functions/api/portrait/[hash]/meta'

const rec = JSON.parse(readFileSync(join(ROOT, 'vectors/portrait-cactus-v2.json'), 'utf8'))
const png = new Uint8Array(readFileSync(join(ROOT, 'vectors/portrait-cactus-v2.png')))
const compile = JSON.parse(readFileSync(join(ROOT, 'vectors/nearai-real-z_ai_glm_5_3_flash-cactus-low.json'), 'utf8'))
const spec = JSON.parse(JSON.parse(compile.response_utf8).choices[0].message.content)
const SIGNER = '0x98a43dfc25d22e12e774c218cc2051f2e480a803'
const HASH = sentenceHash(rec.sentence)

function recorded() {
  const log: { url: string; body?: any; headers?: Record<string, string> }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    log.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> })
    if (url.endsWith('/v1/images/generations')) return new Response(JSON.stringify({ id: rec.id, created: 1763100000, data: [{ b64_json: Buffer.from(png).toString('base64') }], usage: null }))
    if (url.includes('/v1/signature/')) return new Response(JSON.stringify(rec.signature.body))
    return new Response('not here', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchFn, log }
}

describe('portrait v2 against the recorded vector', () => {
  it('the recorded signature is genuine provider_tee from the FLUX signer', () => {
    expect(rec.signature.body.signature_kind).toBe('provider_tee')
    expect(rec.signature.body.text.startsWith(`${PORTRAIT_MODEL}:`)).toBe(true)
    expect(recoverAddress(rec.signature.body.text, rec.signature.body.signature)).toBe(SIGNER)
  })
  it('sends exactly the recorded request: v2 prompt, seed, model, size, b64_json', async () => {
    expect(portraitPrompt(spec.look)).toBe(rec.prompt)
    expect(portraitSeed(HASH)).toBe(rec.seed) // 3156806331 = first 4 bytes of sha256(sentence)
    const e = env({ NEARAI_API_KEY: 'k' })
    await (e.TS_KV as MemKV).put(previewKey(HASH), JSON.stringify({ fighter: { look: spec.look, cry: spec.cry, school: spec.school, style: spec.style, name: spec.name } }))
    const { fetchFn, log } = recorded()
    const img = await portraitFor(e, null, HASH, async () => undefined, fetchFn, { wait: async () => undefined })
    const gen = log.find((l) => l.url.endsWith('/v1/images/generations'))!
    expect(gen.body).toEqual({ model: PORTRAIT_MODEL, prompt: rec.prompt, n: 1, size: '768x960', seed: rec.seed, response_format: 'b64_json' })
    expect(gen.headers!.authorization).toBe('Bearer k')
    expect(img.type).toBe('image/jpeg') // FLUX answers JPEG bytes (the recorder saved them as .png)
    expect(img.bytes.length).toBe(rec.bytes)
    const sig = log.find((l) => l.url.includes('/v1/signature/'))!.url
    expect(sig).toBe(`https://cloud-api.near.ai/v1/signature/${rec.id}?model=${encodeURIComponent(PORTRAIT_MODEL)}&signing_algo=ecdsa`)

    const m = JSON.parse((e.TS_KV as MemKV).store.get(portraitMetaKey(HASH)) as string) as PortraitMeta
    expect(m).toMatchObject({ model: PORTRAIT_MODEL, size: '768x960', seed: rec.seed, id: rec.id, imageSha256: sha256Hex(png), recovered: SIGNER })
    expect(m.signature).toEqual({ ...rec.signature.body, kind: 'provider_tee', signature_kind: undefined })
    expect(m.verified).toBe(false) // the replayed response bytes are not the recorded ones (only the image was kept), so the text cannot match

    const res = await meta(ctx(new Request(`https://t.test/api/portrait/${HASH}/meta`), e, { hash: HASH }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: rec.id, recovered: SIGNER, signature: { signing_address: SIGNER, kind: 'provider_tee' } })
  })
  it('a signature that never comes still serves the image, with signature null', async () => {
    const e = env({ NEARAI_API_KEY: 'k' })
    await (e.TS_KV as MemKV).put(previewKey(HASH), JSON.stringify({ fighter: { look: spec.look, cry: '', school: 'NATURE', style: 'BRAWLER', name: 'x' } }))
    const calls: string[] = []
    const fetchFn = (async (url: string) => {
      calls.push(url)
      if (url.endsWith('/v1/images/generations')) return new Response(JSON.stringify({ id: rec.id, data: [{ b64_json: Buffer.from(png).toString('base64') }] }))
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await portraitFor(e, null, HASH, async () => undefined, fetchFn, { wait: async () => undefined })
    expect(calls.filter((u) => u.includes('/v1/signature/')).length).toBe(3)
    const m = JSON.parse((e.TS_KV as MemKV).store.get(portraitMetaKey(HASH)) as string) as PortraitMeta
    expect(m).toMatchObject({ signature: null, verified: false, recovered: null })
  })
  it('meta of a portrait never generated here is 404 NO_META; a bad hash is 400', async () => {
    const e = env()
    expect((await meta(ctx(new Request(`https://t.test/api/portrait/${HASH}/meta`), e, { hash: HASH }))).status).toBe(404)
    expect((await meta(ctx(new Request('https://t.test/api/portrait/zz/meta'), e, { hash: 'zz' }))).status).toBe(400)
  })
})
