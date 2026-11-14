// The staging stand-in compiler: every output must normalize through the real wasm, sign like NEAR AI's provider_tee text,
// recover to the stand-in address with independent crypto (viem), and be byte-deterministic.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recoverMessageAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { archetypes, env, sim } from './helpers'
import { requestBytes } from '../functions/_lib/nearai'
import { compilerOf, isStandin, standinAddress, standinCompile, STANDIN_MODEL } from '../functions/_lib/standin'
import { buildRaw, rosterRaw, STANDIN_OPENERS } from '../functions/_lib/standinSpec'
import { writeOpener } from '../functions/_lib/opener'
import { sentenceHash } from '../src/game/chain/views'
import { recoverAddress, sha256Hex } from '../src/game/chain/signature'
import { utf8 } from '../src/game/chain/bytes'
import { cleanSentence } from '../src/game/client'

const KEY = '0x' + '5a'.repeat(32)
const e = () => env({ COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: KEY })
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures/request-golden.json'), 'utf8'))
const N = 0xffffffffffffffffffffffffffffffffbaaedce6af48a03bbfd25e8cd0364141n

/** Small seeded generator (no Math.random): the 500 sentences are the same on every run. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 } }
const WORDS = ['goose', 'wizard', 'toaster', 'volcano', 'knight', 'librarian', 'pirate', 'cloud', 'sock', 'dragon', 'monk', 'taxi', 'lamp', 'tiny', 'angry', 'polite', 'who', 'the', 'a', 'of', 'never', 'sleeps', 'on', 'fire', 'CEO\'s', 'naïve', 'café', 'Ünal', '日本語', 'Привет', '🐙', '🔥🔥', '"quoted"', 'back\\slash', '<b>', '&amp;', '50%', '3000', "o'clock", 'x-ray', '—', '...', '!!!']
function sentenceOf(r: () => number): string {
  const n = 1 + Math.floor(r() * 14)
  let s = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]!).join(r() < 0.1 ? '   ' : ' ')
  s = cleanSentence(s)
  const pts = Array.from(s)
  if (pts.length > 120) s = pts.slice(0, 120).join('').trim()
  return Array.from(s).length < 3 ? 'a tiny sock' : s
}

describe('which compiler runs', () => {
  it('stand-in only without a NEAR AI key and with COMPILER_MODE=standin', () => {
    expect(isStandin({ COMPILER_MODE: 'standin' })).toBe(true)
    expect(isStandin({ COMPILER_MODE: 'standin', NEARAI_API_KEY: 'k' })).toBe(false)
    expect(isStandin({})).toBe(false)
    expect(isStandin({ COMPILER_MODE: 'nearai' })).toBe(false)
    expect(compilerOf({ COMPILER_MODE: 'standin' })).toBe('standin')
    expect(compilerOf({ COMPILER_MODE: 'standin', NEARAI_API_KEY: 'k' })).toBe('nearai')
  })
  it('a missing or malformed key is a 503, never a crash or a signature', () => {
    for (const k of [undefined, '', 'abc', 'zz'.repeat(32), '5a'.repeat(31)]) {
      expect(() => standinCompile(env({ COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: k }), sim(), STANDIN_MODEL, 'a goose')).toThrow(/stand-in referee has no signing key/)
    }
  })
})

describe('roster sentences return their curated archetype', () => {
  it.each(archetypes().map((a) => [a.sentence, a.raw] as const))('%s', (sentence, raw) => {
    const c = standinCompile(e(), sim(), STANDIN_MODEL, sentence)
    expect(JSON.parse(c.raw)).toEqual(raw)
    const n = sim().normalize(c.raw)
    expect(n.ok).toBe(true)
  })
  it('matches case-insensitively and after whitespace cleaning', () => {
    expect(rosterRaw('  A  VERY   Polite KRAKEN ')).toEqual(archetypes().find((a) => a.sentence === 'a very polite kraken')!.raw)
    expect(rosterRaw('a very polite kraken!')).toBeNull()
  })
  it('the six opener sentences are exact roster sentences', () => {
    expect(STANDIN_OPENERS).toHaveLength(6)
    for (const s of STANDIN_OPENERS) expect(rosterRaw(s), s).not.toBeNull()
  })
})

describe('built specs normalize through the wasm', () => {
  it('500 random sentences (unicode, emoji, quotes, 3 to 120 chars) all normalize ok with valid caps and 3 distinct moves incl. a strike', () => {
    const r = rng(20261114)
    const strike = new Set(sim().rulebook().library.filter((m) => m.kind === 'strike').map((m) => m.id))
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const s = sentenceOf(r)
      expect(sim().checkSentence(s), s).toBeNull()
      const c = standinCompile(e(), sim(), STANDIN_MODEL, s)
      const n = sim().normalize(c.raw)
      expect(n.ok, `${s} -> ${c.raw}`).toBe(true)
      if (!n.ok) continue
      const raw = JSON.parse(c.raw)
      expect(raw.moves).toHaveLength(3)
      expect(new Set(raw.moves.map((m: { id: string }) => m.id)).size).toBe(3)
      expect(raw.moves.some((m: { id: string }) => strike.has(m.id))).toBe(true)
      for (const w of Object.values(raw.weights) as number[]) expect(w >= 1 && w <= 10).toBe(true)
      // stored text is unchanged by normalize: nothing was clipped or cleaned away behind the contract's back
      for (const f of ['name', 'title', 'look', 'cry'] as const) expect(n.spec[f], f).toBe(raw[f])
      seen.add(n.spec.name)
    }
    expect(seen.size).toBeGreaterThan(150) // names come from the sentence's own words, not a small fixed pool
  })
  it('edge sentences: 3 chars, 120 chars, only punctuation, only emoji, only stop words', () => {
    for (const s of ['abc', 'x'.repeat(120), '...', '!?!', '🐙🐙🐙', 'a an the', '日本語', '"\\"']) {
      expect(sim().checkSentence(s), s).toBeNull()
      expect(sim().normalize(standinCompile(e(), sim(), STANDIN_MODEL, s).raw).ok, s).toBe(true)
    }
  })
  it('the build uses the sentence: school by keyword, name from its words, look mentions it', () => {
    const raw = buildRaw(sim(), 'an enormous lava dragon who loves tax law') as Record<string, any>
    expect(raw.school).toBe('BLAZE')
    expect(raw.name).toBe('Enormous Lava')
    expect(raw.look).toContain('an enormous lava dragon who loves tax law')
    expect(raw.verdict).toBe('ok')
  })
})

describe('the signed envelope', () => {
  const sentence = 'a retired astronaut who sells umbrellas'
  const c = standinCompile(e(), sim(), STANDIN_MODEL, sentence)
  const req = utf8(sim().buildRequest(STANDIN_MODEL, sentence))
  const resp = utf8(c.response)

  it('is an OpenAI-style chat completion whose choices[0].message.content is the raw spec', () => {
    const j = JSON.parse(c.response)
    expect(j.object).toBe('chat.completion')
    expect(j.choices[0].message.content).toBe(c.raw)
    expect(resp.length).toBeLessThan(8 * 1024) // the contract's MAX_RESPONSE_BYTES
  })
  it('signs the provider_tee text: model:sha256(req):sha256(resp)', () => {
    expect(c.signed.text).toBe(`${STANDIN_MODEL}:${sha256Hex(req)}:${sha256Hex(resp)}`)
    expect(c.signed.signature_kind).toBe('provider_tee')
    expect(c.signed.signing_algo).toBe('ecdsa')
    expect(c.verification).toMatchObject({ textMatches: true, signatureValid: true, verified: true })
  })
  it('the signature is 65 bytes, low-s, and recovers to the stand-in address (noble and independent viem)', async () => {
    const sig = c.signed.signature
    expect(sig).toMatch(/^[0-9a-f]{130}$/)
    expect(['1b', '1c']).toContain(sig.slice(128))
    expect(BigInt('0x' + sig.slice(64, 128))).toBeLessThanOrEqual(N / 2n) // the contract rejects high-s
    const addr = standinAddress(KEY)
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/)
    expect(c.signed.signing_address).toBe(addr)
    expect(recoverAddress(c.signed.text, sig)).toBe(addr)
    expect((await recoverMessageAddress({ message: c.signed.text, signature: `0x${sig}` })).toLowerCase()).toBe(addr)
  })
  it('the request bytes are the wasm build_request and the nearai requestBytes', () => {
    expect(sha256Hex(req)).toBe(sha256Hex(requestBytes(sim(), STANDIN_MODEL, sentence)))
    expect(c.verification.requestSha256).toBe(sha256Hex(req))
  })
  it('the request bytes equal the Rust golden for every golden case', () => {
    for (const g of golden.cases as { sentence: string; request_len: number; request_sha256: string }[]) {
      const x = standinCompile(e(), sim(), golden.model, g.sentence)
      expect(x.verification.requestSha256, g.sentence).toBe(g.request_sha256)
      expect(utf8(sim().buildRequest(golden.model, g.sentence)).length).toBe(g.request_len)
    }
  })
  it('is deterministic: same sentence, same bytes and signature, across calls and fresh envs', () => {
    const again = standinCompile(e(), sim(), STANDIN_MODEL, sentence)
    expect(again.response).toBe(c.response)
    expect(again.signed).toEqual(c.signed)
    const other = standinCompile(e(), sim(), STANDIN_MODEL, 'a retired astronaut who sells umbrellas!')
    expect(other.response).not.toBe(c.response)
  })
  it('a different key signs a different address (the allowlist is what makes the stand-in unusable elsewhere)', () => {
    const b = standinCompile(env({ COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: '0x' + '11'.repeat(32) }), sim(), STANDIN_MODEL, sentence)
    expect(b.signed.signing_address).not.toBe(c.signed.signing_address)
    expect(b.verification.verified).toBe(true)
  })
  it('hashes the same sentence the contract hashes', () => {
    expect(sentenceHash(sentence)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('Vance in stand-in mode picks roster sentences and never calls a model', () => {
  const never = (async () => { throw new Error('no network in stand-in mode') }) as unknown as typeof fetch
  it('rotates through the six and skips recent ones', async () => {
    const picked: string[] = []
    for (let season = 1; season <= 6; season++) {
      const r = await writeOpener(e(), STANDIN_MODEL, { seasonId: season, recent: picked }, never)
      expect(r.source).toBe('standin')
      expect(STANDIN_OPENERS).toContain(r.sentence)
      picked.push(r.sentence)
    }
    expect(new Set(picked).size).toBe(6)
    const wrap = await writeOpener(e(), STANDIN_MODEL, { seasonId: 7, recent: picked }, never)
    expect(STANDIN_OPENERS).toContain(wrap.sentence) // all used: it wraps instead of failing
  })
  it('with a NEAR AI key the stand-in is not used', async () => {
    const r = await writeOpener(env({ COMPILER_MODE: 'standin', NEARAI_API_KEY: 'k' }), 'm', { seasonId: 1, recent: [] }, (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)
    expect(r.source).toBe('fallback')
  })
})
