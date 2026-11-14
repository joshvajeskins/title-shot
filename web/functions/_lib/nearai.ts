// NEAR AI Cloud: the signed compile (same exact bytes as the paid forge) and plain chat for openers. Portraits: portraitGen.ts.
// Every paid call reports its `usage` so the spend ledger (ledger.ts) can settle to the real cost.
import { DEFAULTS, type Env } from './env'
import { ApiError } from './http'
import { fromUtf8, utf8 } from '../../src/game/chain/bytes'
import { verifySigned, type SignedResponse, type Verification } from '../../src/game/chain/signature'
import type { Sim } from '../../src/sim'
import type { Usage } from './pricing'

const BASE = DEFAULTS.nearAiBase
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The exact request body bytes from the bout-sim wasm `build_request` (= prefix || json_escape(sentence) || suffix, what the contract rebuilds). */
export function requestBytes(sim: Sim, model: string, sentence: string): Uint8Array {
  return utf8(sim.buildRequest(model, sentence))
}

export interface Compiled {
  raw: string // the model's content JSON (the fighter JSON before normalize)
  response: string // the exact response bytes as text (what was signed)
  signed: SignedResponse
  verification: Verification
  model: string
  usage?: Usage | null
}

/** Called once NEAR AI has answered 200 (so the call is billed): with its usage, or null when the response had none. */
export type Meter = (usage: Usage | null) => void

export function auth(env: Env): Record<string, string> {
  if (!env.NEARAI_API_KEY) throw new ApiError(503, 'AI_UNAVAILABLE', 'The AI referee is offline right now.')
  return { authorization: `Bearer ${env.NEARAI_API_KEY}` }
}

export async function upstream<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(502, 'AI_UPSTREAM', 'The AI referee did not answer. Try again.')
  }
}

/** The usage object of a chat completion, when it has readable token counts. */
export function usageOf(j: unknown): Usage | null {
  const u = (j as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage
  if (!u || !Number.isInteger(u.prompt_tokens) || !Number.isInteger(u.completion_tokens)) return null
  return { prompt_tokens: u.prompt_tokens as number, completion_tokens: u.completion_tokens as number }
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
export async function compile(env: Env, sim: Sim, model: string, sentence: string, fetchFn: typeof fetch = fetch, wait = sleep, meter?: Meter): Promise<Compiled> {
  const body = requestBytes(sim, model, sentence)
  const res = await upstream(fetchFn(`${BASE}/v1/chat/completions`, {
    method: 'POST', body: body as BodyInit, headers: { ...auth(env), 'content-type': 'application/json', accept: 'application/json', 'x-no-aliasing': 'true' },
  }))
  if (res.status !== 200) throw new ApiError(502, 'AI_STATUS', `The AI referee answered ${res.status}.`)
  const respBytes = new Uint8Array(await res.arrayBuffer().catch(() => { meter?.(null); throw new ApiError(502, 'AI_UPSTREAM', 'The AI referee did not answer. Try again.') }))
  const response = fromUtf8(respBytes)
  let parsed: { id?: string; choices?: { message?: { content?: string | null } }[] }
  try { parsed = JSON.parse(response) } catch { meter?.(null); throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI referee sent something unreadable.') }
  const usage = usageOf(parsed)
  meter?.(usage)
  const id = parsed.id
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI response had no usable id.')
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content) throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI response had no content.')
  const signed = await fetchSignature(env, id, model, fetchFn, wait)
  return { raw: content, response, signed, verification: verifySigned(model, body, respBytes, signed), model, usage }
}

/** GLM models think before answering; without a low reasoning effort a short max_tokens ends in reasoning with no content. */
export const reasoningFor = (model: string): Record<string, string> => (/glm/i.test(model) ? { reasoning_effort: 'low' } : {})

/** Free-form chat (promoter opener). Not signed, not part of the game rules. */
export async function chatText(env: Env, model: string, system: string, user: string, fetchFn: typeof fetch = fetch, meter?: Meter): Promise<string> {
  const res = await upstream(fetchFn(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { ...auth(env), 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...reasoningFor(model), temperature: 0.9, max_tokens: 60, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }))
  if (!res.ok) throw new ApiError(502, 'AI_STATUS', `The AI referee answered ${res.status}.`)
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[] } | null
  meter?.(usageOf(j))
  const t = j?.choices?.[0]?.message?.content
  if (typeof t !== 'string') throw new ApiError(502, 'AI_BAD_RESPONSE', 'The AI response had no content.')
  return t
}
