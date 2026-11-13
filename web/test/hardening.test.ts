import { describe, expect, it } from 'vitest'
import { archetypes, env, recordedExchange, sim, TEST_ADDRESS } from './helpers'
import { runPreview } from '../functions/_lib/preview'
import { clearMemoryCache } from '../functions/_lib/cache'
import { ApiError, parseBody, readLimited } from '../functions/_lib/http'
import { publicDetail, publicTick, type TickLog } from '../functions/_lib/tickTypes'
import { cleanSentence } from '../src/game/client'
import { z } from 'zod'

const MODEL = 'Qwen/Qwen3.8-27B'
const SENTENCE = 'a pigeon with a law degree'

describe('preview attested = verified AND allowlisted signer AND the contract signature kind', () => {
  const run = async (opts: { list?: string[]; kind?: string; chain?: boolean; down?: boolean; exKind?: 'provider_tee' | 'gateway' }) => {
    clearMemoryCache()
    const ex = recordedExchange(sim(), MODEL, SENTENCE, JSON.stringify(archetypes()[0]!.raw), opts.exKind ?? 'provider_tee')
    const fetchFn = (async (url: string) => {
      if (url.includes('/chat/completions')) return new Response(ex.response)
      return new Response(JSON.stringify({ text: ex.text, signature: ex.signature, signing_address: ex.signing_address, signing_algo: 'ecdsa', signature_kind: ex.kind }))
    }) as unknown as typeof fetch
    const chain = opts.chain === false ? null : ({
      fighterBySentence: async () => null,
      config: async () => ({ model_id: MODEL, signature_kind: opts.kind ?? 'provider_tee' }),
      allowlist: async () => (opts.down ? Promise.reject(new Error('rpc')) : { active: opts.list ?? [TEST_ADDRESS], pending: null }),
    } as any)
    return runPreview({ env: env({ NEARAI_API_KEY: 'k' }), sim: sim(), chain, fetchFn }, SENTENCE)
  }
  it('true when the signer is on the active allowlist and the kind matches (case and 0x prefix do not matter)', async () => {
    expect((await run({})).attested).toBe(true)
    expect((await run({ list: [TEST_ADDRESS.toUpperCase().replace('0X', '0x')] })).attested).toBe(true)
    expect((await run({ list: [TEST_ADDRESS.slice(2)] })).attested).toBe(true)
  })
  it('false when the signature is valid but the signer is not allowlisted (verified alone overstates it)', async () => {
    const r = await run({ list: ['0x' + '12'.repeat(20)] })
    expect(r.verified).toBe(true)
    expect(r.attested).toBe(false)
  })
  it('false when the signature kind differs from the one the contract expects', async () => {
    const r = await run({ kind: 'gateway' })
    expect(r.verified).toBe(true)
    expect(r.attested).toBe(false)
    expect((await run({ kind: 'gateway', exKind: 'gateway' })).attested).toBe(true)
  })
  it('null (unknown) when the contract cannot be read or is not deployed', async () => {
    expect((await run({ down: true })).attested).toBeNull()
    expect((await run({ chain: false })).attested).toBeNull()
  })
})

describe('request bodies are read with a hard byte limit', () => {
  const stream = (chunks: string[], pulled: { n: number }) => new ReadableStream<Uint8Array>({
    pull(c) { const next = chunks[pulled.n++]; if (next === undefined) c.close(); else c.enqueue(new TextEncoder().encode(next)) },
  })
  const req = (body: ReadableStream<Uint8Array>) => new Request('https://t.test/x', { method: 'POST', body, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit)
  it('stops pulling and answers 413 once the limit is passed, even without a content-length', async () => {
    const pulled = { n: 0 }
    const chunks = Array.from({ length: 500 }, () => 'x'.repeat(1024))
    await expect(readLimited(req(stream(chunks, pulled)), 8 * 1024)).rejects.toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' })
    expect(pulled.n).toBeLessThan(40) // nowhere near all 500 KB was buffered
  })
  it('a body inside the limit is read whole, multi-byte characters intact', async () => {
    const out = await readLimited(req(stream(['{"s":"caf', 'é \u{1f54a}"}'], { n: 0 })), 8 * 1024)
    expect(JSON.parse(out)).toEqual({ s: 'café \u{1f54a}' })
  })
  it('parseBody still validates after the streamed read', async () => {
    const ok = await parseBody(req(stream(['{"a":"hello"}'], { n: 0 })), z.object({ a: z.string() }))
    expect(ok).toEqual({ a: 'hello' })
    await expect(parseBody(req(stream(['{"a":'], { n: 0 })), z.object({ a: z.string() }))).rejects.toMatchObject({ code: 'BAD_JSON' })
    await expect(parseBody(req(stream(['x'.repeat(9000)], { n: 0 })), z.object({ a: z.string() }))).rejects.toBeInstanceOf(ApiError)
  })
  it('an empty body is a 400, not a crash', async () => {
    await expect(parseBody(new Request('https://t.test/x', { method: 'POST', headers: { 'content-type': 'application/json' } }), z.object({}))).rejects.toMatchObject({ status: 400 })
  })
})

describe('the public tick log never carries raw exception text', () => {
  it('failed steps keep only a stable code; everything else becomes "error"', () => {
    expect(publicDetail({ action: 'x', ok: false, detail: 'E_NO_ADDRESS: purse address not set yet' })).toBe('E_NO_ADDRESS')
    expect(publicDetail({ action: 'x', ok: false, detail: 'DUST: amount does not cover gas' })).toBe('DUST')
    expect(publicDetail({ action: 'x', ok: false, detail: 'VANCE_DRY: fund 0xabc on Base Sepolia' })).toBe('VANCE_DRY')
    expect(publicDetail({ action: 'x', ok: false, detail: 'OPEN_BACKOFF: season 4 aborted' })).toBe('OPEN_BACKOFF')
    expect(publicDetail({ action: 'x', ok: false, detail: 'fetch failed: https://rpc.example/?key=SECRET123' })).toBe('error')
    expect(publicDetail({ action: 'x', ok: false, detail: 'TypeError: Cannot read properties of undefined' })).toBe('error')
    expect(publicDetail({ action: 'x', ok: false, detail: 'Error: bad key sk-live-abc' })).toBe('error')
  })
  it('successful steps keep our own text (amounts, opener sentence), capped', () => {
    expect(publicDetail({ action: 'x', ok: true, detail: '"a lighthouse that moonlights as a DJ" (nearai)' })).toContain('lighthouse')
    expect(publicDetail({ action: 'x', ok: true, detail: 'y'.repeat(500) })!.length).toBe(140)
    expect(publicDetail({ action: 'x', ok: true })).toBeUndefined()
  })
  it('publicTick maps every step and leaves the stored log untouched', () => {
    const t: TickLog = { at: 1, ms: 2, steps: [{ action: 'a', ok: false, detail: 'connect ECONNREFUSED 10.0.0.1:443' }, { action: 'b', ok: true, tx: 'abc' }] }
    const p = publicTick(t)!
    expect(p.steps[0]!.detail).toBe('error')
    expect(p.steps[1]).toEqual({ action: 'b', ok: true, tx: 'abc' })
    expect(t.steps[0]!.detail).toContain('ECONNREFUSED')
    expect(publicTick(null)).toBeNull()
  })
})

describe('cleanSentence collapses exactly the characters Rust split_whitespace does (Unicode White_Space)', () => {
  // https://www.unicode.org/Public/UCD/latest/ucd/PropList.txt (White_Space), what char::is_whitespace uses
  const RUST_WS = new Set<number>([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
  it('agrees on every code point', () => {
    const bad: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCodePoint(cp)
      const got = cleanSentence(`a${ch}b`)
      const want = RUST_WS.has(cp) ? 'a b' : `a${ch}b`
      if (got !== want) bad.push(cp.toString(16))
      if (cleanSentence(`${ch}a${ch}`) !== (RUST_WS.has(cp) ? 'a' : `${ch}a${ch}`)) bad.push(`trim:${cp.toString(16)}`)
    }
    expect(bad).toEqual([])
  })
  it('the two known JS/Rust differences', () => {
    expect(cleanSentence('a\u0085b')).toBe('a b') // Rust collapses NEL, JS \s does not
    expect(cleanSentence('a﻿b')).toBe('a﻿b') // JS \s and trim() eat the BOM, Rust keeps it
    expect(cleanSentence('﻿a')).toBe('﻿a')
  })
  it('keeps the usual behaviour', () => {
    expect(cleanSentence('  a \t\n  pigeon   with a law degree ')).toBe('a pigeon with a law degree')
    expect(cleanSentence('   ')).toBe('')
    expect(cleanSentence('x')).toBe('x')
  })
})
