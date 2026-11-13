// Portrait and battle-cry generation with KV caching. Generation is rate limited; cache hits are free.
import type { Chain } from './chain'
import { getJson, putJson } from './cache'
import type { Env, KVLike } from './env'
import { ApiError } from './http'
import { lookupFighter, MISS_TTL_SEC, missKey } from './lookup'
import { CAPS, spendCap } from './ratelimit'
import { generatePortrait, sniffImage } from './nearai'
import { cleanCry, pickVoice } from './voices'

const inflight = new Map<string, Promise<unknown>>()
const once = <T>(key: string, f: () => Promise<T>): Promise<T> => {
  const hit = inflight.get(key) as Promise<T> | undefined
  if (hit) return hit
  const p = f().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function getBytes(kv: KVLike, key: string): Promise<Uint8Array | null> {
  try { const b = await kv.get(key, 'arrayBuffer'); return b ? new Uint8Array(b) : null } catch { return null }
}
async function putBytes(kv: KVLike, key: string, bytes: Uint8Array): Promise<void> {
  try { await kv.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) } catch { /* cache only */ }
}

/** The fighter behind a hash, or a 404 that is itself cached for a minute (unknown hashes are free to ask for, so they must be cheap to refuse). */
async function knownFighter(kv: KVLike, chain: Chain | null, hash: string, kind: 'portrait' | 'cry') {
  if (await getJson(kv, missKey(kind, hash))) throw new ApiError(404, 'NO_FIGHTER', 'No such fighter.')
  const status = { chainError: false }
  const fighter = await lookupFighter(kv, chain, hash, status)
  if (!fighter) {
    if (!status.chainError) await putJson(kv, missKey(kind, hash), 1, MISS_TTL_SEC) // an RPC outage is not "no such fighter"
    throw new ApiError(404, 'NO_FIGHTER', 'No such fighter.')
  }
  return fighter
}

export interface Media { bytes: Uint8Array; type: string }

export async function portraitFor(env: Env, chain: Chain | null, hash: string, gate: () => Promise<void>, fetchFn: typeof fetch = fetch): Promise<Media> {
  const kv = env.TS_KV
  const hit = await getBytes(kv, `portrait:${hash}`)
  if (hit) return { bytes: hit, type: sniffImage(hit) }
  if (await getJson(kv, `portrait-none:${hash}`)) throw new ApiError(404, 'NO_PORTRAIT', 'No portrait available.')
  const fighter = await knownFighter(kv, chain, hash, 'portrait')
  return once(`portrait:${hash}`, async () => {
    await gate()
    await spendCap(kv, CAPS.portraitGen)
    const look = fighter.look.replace(/[^\p{L}\p{N} .,'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    const img = await generatePortrait(env, look, hash, fetchFn).catch(() => null)
    if (!img) {
      await putJson(kv, `portrait-none:${hash}`, 1, 300)
      throw new ApiError(404, 'NO_PORTRAIT', 'No portrait available.')
    }
    await putBytes(kv, `portrait:${hash}`, img.bytes)
    return img
  })
}

export async function cryFor(env: Env, chain: Chain | null, hash: string, gate: () => Promise<void>, fetchFn: typeof fetch = fetch): Promise<Media> {
  const kv = env.TS_KV
  const hit = await getBytes(kv, `cry:${hash}`)
  if (hit) return { bytes: hit, type: 'audio/mpeg' }
  const fighter = await knownFighter(kv, chain, hash, 'cry')
  const text = cleanCry(fighter.cry)
  if (!text) throw new ApiError(422, 'NO_CRY', 'This fighter has nothing to shout.')
  if (!env.ELEVENLABS_API_KEY) throw new ApiError(503, 'TTS_UNAVAILABLE', 'The battle cry booth is offline.')
  const voice = pickVoice(fighter.school, fighter.style, hash)
  return once(`cry:${hash}`, async () => {
    await gate()
    await spendCap(kv, CAPS.cryGen)
    let res: Response
    try {
      res = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=mp3_44100_64`, {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: voice.model_id || 'eleven_v3', voice_settings: { stability: voice.stability, similarity_boost: voice.similarity_boost } }),
      })
    } catch { throw new ApiError(502, 'TTS_UPSTREAM', 'The battle cry booth did not answer.') }
    if (!res.ok) throw new ApiError(502, 'TTS_UPSTREAM', 'The battle cry booth did not answer.')
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length < 256 || bytes.length > 2_000_000) throw new ApiError(502, 'TTS_UPSTREAM', 'The battle cry booth sent something unusable.')
    await putBytes(kv, `cry:${hash}`, bytes)
    return { bytes, type: 'audio/mpeg' }
  })
}
