// Fighter portraits with NEAR AI Cloud images: FLUX.2-klein, the v2 mascot prompt (spikes/ecrecover/scripts/record-portrait.mjs),
// a seed from the sentence hash, and the provider_tee signature of the generation kept beside the image for the receipts UI.
import { DEFAULTS, type Env } from './env'
import { auth, upstream } from './nearai'
import { utf8 } from '../../src/game/chain/bytes'
import { recoverAddress, sha256Hex, verifySigned, type SignedResponse } from '../../src/game/chain/signature'

export const PORTRAIT_MODEL = 'black-forest-labs/FLUX.2-klein-4B'
export const PORTRAIT_SIZE = '768x960'
export const PORTRAIT_STYLE = 'Bust portrait, three-quarter view facing right, chest-up, centered, plain flat vermilion background. Bold vintage fight-poster illustration: confident ink linework, flat colour shapes, coarse halftone dot shading, warm paper grain. Limited palette: ink black, cream, vermilion red, brass gold. No text, no letters, no logos.'
export const portraitPrompt = (look: string): string =>
  `Cartoon mascot character, a single non-human character with its own face, eyes and expressive pose; its whole body IS the subject described here: ${look} No people, no humans, no human faces. ${PORTRAIT_STYLE}`
/** First 4 bytes of sha256(sentence) as a uint32: the fighter hash IS sha256 of the clean sentence. */
export const portraitSeed = (hashHex: string): number => parseInt(hashHex.slice(0, 8), 16)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function sniffImage(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  return 'image/png'
}

/** What /api/portrait/:hash/meta returns: how the image was made and NEAR AI's signature over that exchange. */
export interface PortraitMeta {
  model: string; size: string; seed: number; id: string | null; imageSha256: string
  requestSha256: string; responseSha256: string
  /** the provider_tee signature (text = model:sha256(request):sha256(response)), or null when NEAR AI did not return one */
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; kind: string } | null
  /** the signature recovers to signing_address and its text names these exact request and response bytes */
  verified: boolean
  recovered: string | null
  at: number
}
export interface Portrait { bytes: Uint8Array; type: string; meta: PortraitMeta }
/** `billed`: 'image' = NEAR AI answered 200 (one image charged), 'free' = it refused, 'unknown' = the request may have gone through. */
export interface PortraitResult { img: Portrait | null; billed: 'image' | 'free' | 'unknown' }

/** GET /v1/signature/{id}?model=…&signing_algo=ecdsa, a few tries (it can lag the generation). Null when it never arrives. */
export async function portraitSignature(env: Env, id: string, fetchFn: typeof fetch, wait = sleep): Promise<SignedResponse | null> {
  for (let i = 0; i < 3; i++) {
    if (i) await wait(600)
    try {
      const r = await fetchFn(`${DEFAULTS.nearAiBase}/v1/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(PORTRAIT_MODEL)}&signing_algo=ecdsa`, { headers: auth(env) })
      if (!r.ok) continue
      const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
      if (j && typeof j.text === 'string' && typeof j.signature === 'string') {
        return { text: j.text, signature: j.signature, signing_address: String(j.signing_address ?? ''), signing_algo: String(j.signing_algo ?? ''), signature_kind: String(j.signature_kind ?? '') }
      }
    } catch { /* try again */ }
  }
  return null
}

/** Generate one portrait. Never throws for upstream trouble: `img` is null and `billed` says whether it cost anything. */
export async function generatePortrait(env: Env, look: string, hashHex: string, fetchFn: typeof fetch = fetch, wait = sleep): Promise<PortraitResult> {
  if (!env.NEARAI_API_KEY) return { img: null, billed: 'free' }
  const seed = portraitSeed(hashHex)
  const reqText = JSON.stringify({ model: PORTRAIT_MODEL, prompt: portraitPrompt(look), n: 1, size: PORTRAIT_SIZE, seed, response_format: 'b64_json' })
  let res: Response
  try {
    res = await upstream(fetchFn(`${DEFAULTS.nearAiBase}/v1/images/generations`, { method: 'POST', headers: { ...auth(env), 'content-type': 'application/json', 'accept-encoding': 'identity' }, body: reqText }))
  } catch { return { img: null, billed: 'unknown' } }
  if (!res.ok) return { img: null, billed: 'free' }
  let respBytes: Uint8Array
  try { respBytes = new Uint8Array(await res.arrayBuffer()) } catch { return { img: null, billed: 'image' } }
  let j: { id?: unknown; data?: { b64_json?: string }[] } | null = null
  try { j = JSON.parse(new TextDecoder().decode(respBytes)) } catch { return { img: null, billed: 'image' } }
  const b64 = j?.data?.[0]?.b64_json
  let bytes: Uint8Array | null = null
  try { if (typeof b64 === 'string') bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) } catch { bytes = null }
  if (!bytes || bytes.length < 64 || bytes.length > 8_000_000) return { img: null, billed: 'image' }
  const id = typeof j?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(j.id) ? j.id : null
  const signed = id ? await portraitSignature(env, id, fetchFn, wait) : null
  const req = utf8(reqText)
  const v = signed ? verifySigned(PORTRAIT_MODEL, req, respBytes, signed) : null
  let recovered: string | null = v?.recovered ?? null
  if (signed && !recovered) { try { recovered = recoverAddress(signed.text, signed.signature) } catch { recovered = null } }
  const meta: PortraitMeta = {
    model: PORTRAIT_MODEL, size: PORTRAIT_SIZE, seed, id, imageSha256: sha256Hex(bytes), requestSha256: sha256Hex(req), responseSha256: sha256Hex(respBytes),
    signature: signed ? { text: signed.text, signature: signed.signature, signing_address: signed.signing_address, signing_algo: signed.signing_algo, kind: signed.signature_kind } : null,
    verified: v?.verified ?? false, recovered, at: Date.now(),
  }
  return { img: { bytes, type: sniffImage(bytes), meta }, billed: 'image' }
}
