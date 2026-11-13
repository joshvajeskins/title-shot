// NEAR AI Cloud: the signed compile (same exact bytes as the paid forge), plain chat for openers, image generation.
import { DEFAULTS, type Env } from './env'
import { ApiError } from './http'
import { fromUtf8, utf8 } from '../../src/game/chain/bytes'
import { verifySigned, type SignedResponse, type Verification } from '../../src/game/chain/signature'
import type { Sim } from '../../src/sim'

const BASE = DEFAULTS.nearAiBase
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The exact request body bytes: prefix || json_escape(sentence) || suffix (what the contract rebuilds). */
export function requestBytes(sim: Sim, model: string, sentence: string): Uint8Array {
  const { prefix, suffix } = sim.requestParts(model)
  return utf8(prefix + JSON.stringify(sentence).slice(1, -1) + suffix)
}

export interface Compiled {
  raw: string // the model's content JSON (the fighter JSON before normalize)
  response: string // the exact response bytes as text (what was signed)
  signed: SignedResponse
  verification: Verification
  model: string
}

function auth(env: Env): Record<string, string> {
  if (!env.NEARAI_API_KEY) throw new ApiError(503, 'AI_UNAVAILABLE', 'The AI referee is offline right now.')
  return { authorization: `Bearer ${env.NEARAI_API_KEY}` }
}

async function upstream<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(502, 'AI_UPSTREAM', 'The AI referee did not answer. Try again.')
  }
}

export async function fetchSignature(env: Env, chatId: string, model: string, fetchFn: typeof fetch = fetch, wait = sleep): Promise<SignedResponse> {
  const attempts = 5
  let status = 0
  for (let i = 0; i < attempts; i++) {
    const q = i === attempts - 1 ? `?signing_algo=ecdsa&model=${encodeURIComponent(model)}` : '?signing_algo=ecdsa'
    const r = await upstream(fetchFn(`${BASE}/v1/signature/${encodeURIComponent(chatId)}${q}`, { headers: auth(env) }))
    status = r.status
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
      if (j && !j.error_code && typeof j.signature === 'string' && typeof j.text === 'string') {
        return {
          text: j.text, signature: j.signature, signing_address: String(j.signing_address ?? ''),
          signing_algo: String(j.signing_algo ?? ''), signature_kind: String(j.signature_kind ?? ''),
        }
      }
    }
    if (i + 1 < attempts) await wait(700)
  }
  throw new ApiError(502, 'AI_NO_SIGNATURE', `The AI signature was not available (HTTP ${status}).`)
}

/** Compile one sentence with NEAR AI and fetch + check its signature. Mirrors forge/src/compile.rs. */
export async function compile(env: Env, sim: Sim, model: string, sentence: string, fetchFn: typeof fetch = fetch, wait = sleep): Promise<Compiled> {
  const body = requestBytes(sim, model, sentence)
  const res = await upstream(fetchFn(`${BASE}/v1/chat/completions`, {
    method: 'POST', body: body as BodyInit, headers: { ...auth(env), 'content-type': 'application/json', accept: 'application/json', 'x-no-aliasing': 'true' },
  }))
  const respBytes = new Uint8Array(await res.arrayBuffer())
  if (res.status !== 200) throw new ApiError(502, 'AI_STATUS', `The AI referee answered ${res.status}.`)
  const response = fromUtf8(respBytes)
  let parsed: { id?: string; choices?: { message?: { content?: string | null } }[] }
  try { parsed = JSON.parse(response) } catch { throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI referee sent something unreadable.') }
  const id = parsed.id
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI response had no usable id.')
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content) throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI response had no content.')
  const signed = await fetchSignature(env, id, model, fetchFn, wait)
  return { raw: content, response, signed, verification: verifySigned(model, body, respBytes, signed), model }
}

/** Free-form chat (promoter opener). Not signed, not part of the game rules. */
export async function chatText(env: Env, model: string, system: string, user: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await upstream(fetchFn(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { ...auth(env), 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.9, max_tokens: 60, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }))
  if (!res.ok) throw new ApiError(502, 'AI_STATUS', `The AI referee answered ${res.status}.`)
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[] } | null
  const t = j?.choices?.[0]?.message?.content
  if (typeof t !== 'string') throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI response had no content.')
  return t
}

interface ModelRow { id?: string; modalities?: string[]; output_modalities?: string[]; architecture?: { output_modalities?: string[] } }

/** FLUX (or any image model) from `GET /v1/models`. Public listing, no key needed. */
export async function pickImageModel(fetchFn: typeof fetch = fetch): Promise<string | null> {
  const r = await upstream(fetchFn(`${BASE}/v1/models`))
  if (!r.ok) return null
  const j = (await r.json().catch(() => null)) as { data?: ModelRow[] } | null
  const rows = (j?.data ?? []).filter((m): m is ModelRow & { id: string } => typeof m.id === 'string')
  const isImage = (m: ModelRow & { id: string }) =>
    /image/.test([...(m.output_modalities ?? []), ...(m.architecture?.output_modalities ?? []), ...(m.modalities ?? [])].join(' ')) || /flux|image|sdxl|stable-diffusion/i.test(m.id)
  const imgs = rows.filter(isImage)
  return (imgs.find((m) => /flux/i.test(m.id)) ?? imgs[0])?.id ?? null
}

export const PORTRAIT_STYLE = 'Vertical fight-poster illustration, single character centred and full figure, bold ink outlines, grainy risograph print texture, deep midnight-navy background with warm gold and red accents, dramatic rim lighting, no text, no letters, no logos, no watermark. Character: '

export function sniffImage(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  return 'image/png'
}

/** Generate a portrait; returns bytes + content type, or null when generation is unavailable. */
export async function generatePortrait(env: Env, look: string, hashHex: string, fetchFn: typeof fetch = fetch): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!env.NEARAI_API_KEY) return null
  const model = await pickImageModel(fetchFn)
  if (!model) return null
  const seed = parseInt(hashHex.slice(0, 8), 16)
  const res = await upstream(fetchFn(`${BASE}/v1/images/generations`, {
    method: 'POST', headers: { ...auth(env), 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: PORTRAIT_STYLE + look, n: 1, size: '768x1024', response_format: 'b64_json', seed }),
  }))
  if (!res.ok) return null
  const j = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[] } | null
  const item = j?.data?.[0]
  let bytes: Uint8Array | null = null
  if (item?.b64_json) {
    bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0))
  } else if (item?.url && /^https:\/\//.test(item.url)) {
    const img = await upstream(fetchFn(item.url))
    if (img.ok) bytes = new Uint8Array(await img.arrayBuffer())
  }
  if (!bytes || bytes.length < 64 || bytes.length > 8_000_000) return null
  return { bytes, type: sniffImage(bytes) }
}
