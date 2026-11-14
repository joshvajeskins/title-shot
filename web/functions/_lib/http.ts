// Response helpers, zod body parsing and the one error shape: { error, code }. Never a raw upstream error.
import { z, type ZodType } from 'zod'
import type { Env } from './env'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message)
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })

export const errorResponse = (e: unknown): Response => {
  if (e instanceof ApiError) {
    return json({ error: e.message, code: e.code }, e.status, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {})
  }
  return json({ error: 'Something went wrong. Try again.', code: 'INTERNAL' }, 500)
}

export type Ctx = { request: Request; env: Env; params: Record<string, string | string[]>; waitUntil: (p: Promise<unknown>) => void }

/** Wrap a handler so every failure leaves as { error, code } with the right status. */
export function handle(fn: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx): Promise<Response> => {
    try {
      return await fn(c)
    } catch (e) {
      if (!(e instanceof ApiError)) console.error('unhandled', e instanceof Error ? e.name : typeof e)
      return errorResponse(e)
    }
  }
}

export function methodGuard(request: Request, allowed: string[]) {
  if (!allowed.includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Use ${allowed.join(' or ')}.`)
}

const MAX_BODY = 8 * 1024

/** Read the body but stop (and refuse) as soon as it passes `max` bytes: a missing or lying content-length cannot make us buffer it all. */
export async function readLimited(request: Request, max: number): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel().catch(() => undefined); throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body too large.') }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { all.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(all)
}

/** Parse and validate a JSON body. Oversized, malformed or invalid input is a 400, never a crash. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const ct = request.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().includes('application/json')) throw new ApiError(415, 'BAD_CONTENT_TYPE', 'Send application/json.')
  const len = Number(request.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body too large.')
  const text = await readLimited(request, MAX_BODY)
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new ApiError(400, 'BAD_JSON', 'Body is not valid JSON.') }
  const r = schema.safeParse(data)
  if (!r.success) {
    const issue = r.error.issues[0]
    throw new ApiError(400, 'BAD_INPUT', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`)
  }
  return r.data
}

/**
 * The rate-limit identity of a request: the IPv4 address, or the /64 prefix of an IPv6 one (one subscriber usually holds a
 * whole /64, so per-address limits would be free to rotate around).
 */
export const clientIp = (request: Request): string => ipBucket((request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local').slice(0, 64))

export function ipBucket(ip: string): string {
  if (!ip.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.replace(/^::ffff:/i, '')
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]!.split('::')
  const h = head ? head.split(':') : []
  const t = ip.includes('::') && tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip // not a plain IPv6 address: keep it whole
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

/** 64 lowercase/uppercase hex chars -> lowercase, else 400. */
export const hashParam = z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected a 64-character hex hash').transform((s) => s.toLowerCase())

/** Constant-time string comparison (shared tokens). */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let d = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return d === 0
}

export function parseHashParam(v: unknown): string {
  const r = hashParam.safeParse(Array.isArray(v) ? v[0] : v)
  if (!r.success) throw new ApiError(400, 'BAD_HASH', 'Expected a 64-character hex hash.')
  return r.data
}
