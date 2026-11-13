import { describe, expect, it } from 'vitest'
import { ctx, env, json } from './helpers'
import { onRequest as preview } from '../functions/api/preview'
import { onRequest as guest } from '../functions/api/guest'
import { onRequest as tick } from '../functions/api/tick'
import { onRequest as state } from '../functions/api/state'
import { onRequest as portrait } from '../functions/api/portrait/[hash]'
import { onRequest as cry } from '../functions/api/cry/[hash]'
import { handle, ApiError, safeEqual } from '../functions/_lib/http'
import { formatPublicKey, generateKeyPair } from '../src/game/chain/keys'

const HASH = 'ab'.repeat(32)
const KEY = formatPublicKey(generateKeyPair().publicKey)
const KEY2 = formatPublicKey(generateKeyPair().publicKey)
const shape = async (r: Response) => { const j = await r.json() as { error?: unknown; code?: unknown }; expect(typeof j.error).toBe('string'); expect(typeof j.code).toBe('string'); return j as { error: string; code: string } }

describe('POST /api/preview rejects hostile input before touching any upstream', () => {
  const call = (body: unknown, init: RequestInit = {}, e = env()) => preview(ctx(json('/api/preview', body, init), e))
  it('invalid JSON is 400 BAD_JSON', async () => { const r = await call('{nope'); expect(r.status).toBe(400); expect((await shape(r)).code).toBe('BAD_JSON') })
  it('wrong content type is 415', async () => { const r = await call({ sentence: 'a goose' }, { headers: { 'content-type': 'text/plain' } }); expect(r.status).toBe(415) })
  it('wrong shapes are 400 BAD_INPUT', async () => {
    for (const b of [{ sentence: 42 }, {}, [], null, '"x"', { sentence: ['a'] }, { sentence: 'a goose', admin: true }, { sentence: '' }]) {
      const r = await call(b)
      expect(r.status, JSON.stringify(b)).toBe(400)
      expect((await shape(r)).code).toBe('BAD_INPUT')
    }
  })
  it('over-long and control-character sentences are 400 BAD_SENTENCE or BAD_INPUT', async () => {
    const long = await call({ sentence: 'x'.repeat(121) })
    expect(long.status).toBe(400)
    expect((await shape(long)).code).toBe('BAD_SENTENCE')
    expect((await call({ sentence: 'x'.repeat(401) })).status).toBe(400)
    const ctl = await call({ sentence: 'bad\u0000sentence here' })
    expect(ctl.status).toBe(400)
    expect((await shape(ctl)).code).toBe('BAD_SENTENCE')
    expect((await call({ sentence: '  ab  ' })).status).toBe(400)
  })
  it('an oversized body is 413', async () => { const r = await call({ sentence: 'a'.repeat(9000) }); expect(r.status).toBe(413); expect((await shape(r)).code).toBe('BODY_TOO_LARGE') })
  it('GET is 405', async () => { const r = await preview(ctx(new Request('https://t.test/api/preview'), env())); expect(r.status).toBe(405); await shape(r) })
  it('a valid sentence with no AI key is a clean 503, not a crash', async () => {
    const r = await call({ sentence: 'a very polite kraken' })
    expect(r.status).toBe(503)
    expect((await shape(r)).code).toBe('AI_UNAVAILABLE')
  })
  it('the 13th request in a minute from one IP is 429 with Retry-After', async () => {
    const e = env()
    const mk = () => preview(ctx(json('/api/preview', { sentence: 'x' }, { headers: { 'cf-connecting-ip': '5.5.5.5' } }), e))
    for (let i = 0; i < 12; i++) expect((await mk()).status).toBe(400)
    const r = await mk()
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBeTruthy()
    expect((await shape(r)).code).toBe('RATE_LIMITED')
  })
})

describe('POST /api/guest validates keys and refuses to run unconfigured', () => {
  const call = (body: unknown, e = env({ CONTRACT_ID: 'titleshot.testnet' })) => guest(ctx(json('/api/guest', body), e))
  it('bad keys are 400', async () => {
    for (const b of [{ publicKey: 'nope', sessionKey: 'nope' }, { publicKey: KEY }, { publicKey: 'secp256k1:abc', sessionKey: KEY }, { publicKey: KEY, sessionKey: KEY }, { publicKey: KEY, sessionKey: KEY2, extra: 1 }, { publicKey: 'ed25519:' + '1'.repeat(300), sessionKey: KEY }, '{x']) {
      const r = await call(b)
      expect(r.status, JSON.stringify(b)).toBe(400)
      await shape(r)
    }
  })
  it('a base58 key of the wrong length is 400', async () => { expect((await call({ publicKey: 'ed25519:' + '1'.repeat(10), sessionKey: KEY })).status).toBe(400) })
  it('without a deployed contract it is 503 NOT_DEPLOYED', async () => { const r = await call({ publicKey: KEY, sessionKey: KEY2 }, env()); expect(r.status).toBe(503); expect((await shape(r)).code).toBe('NOT_DEPLOYED') })
  it('without the sponsor key it is 503 SPONSOR_DRY and burns no rate-limit budget', async () => {
    const e = env({ CONTRACT_ID: 'titleshot.testnet' })
    for (let i = 0; i < 5; i++) { const r = await guest(ctx(json('/api/guest', { publicKey: KEY, sessionKey: KEY2 }), e)); expect(r.status).toBe(503); expect((await shape(r)).code).toBe('SPONSOR_DRY') }
  })
  it('GET is 405', async () => expect((await guest(ctx(new Request('https://t.test/api/guest'), env()))).status).toBe(405))
})

describe('GET /api/portrait/:hash and /api/cry/:hash', () => {
  it('malformed hashes are 400 BAD_HASH', async () => {
    for (const h of ['not-a-hash', 'ab'.repeat(31), 'zz'.repeat(32), '../../etc/passwd', 'ab'.repeat(33), '']) {
      for (const fn of [portrait, cry]) {
        const r = await fn(ctx(new Request('https://t.test/x'), env(), { hash: h }))
        expect(r.status, h).toBe(400)
        expect((await shape(r)).code).toBe('BAD_HASH')
      }
    }
  })
  it('an unknown fighter is a clean 404', async () => {
    for (const fn of [portrait, cry]) {
      const r = await fn(ctx(new Request('https://t.test/x'), env(), { hash: HASH }))
      expect(r.status).toBe(404)
      expect((await shape(r)).code).toBe('NO_FIGHTER')
    }
  })
  it('POST is 405', async () => expect((await portrait(ctx(new Request('https://t.test/x', { method: 'POST' }), env(), { hash: HASH }))).status).toBe(405))
})

describe('POST /api/tick is token-gated', () => {
  const call = (token: string | null, e = env({ TICK_SECRET: 'right-token-value', CONTRACT_ID: 'titleshot.testnet' }), method = 'POST') =>
    tick(ctx(new Request('https://t.test/api/tick', { method, headers: token === null ? {} : { 'x-tick-secret': token } }), e))
  it('no token, wrong token, prefix of the token: 401', async () => {
    for (const t of [null, '', 'wrong', 'right-token', 'right-token-valuX']) { const r = await call(t); expect(r.status, String(t)).toBe(401); expect((await shape(r)).code).toBe('UNAUTHORIZED') }
  })
  it('no token configured at all refuses everyone', async () => expect((await call('anything', env())).status).toBe(401))
  it('the right token without a contract is 503', async () => { const r = await call('right-token-value', env({ TICK_SECRET: 'right-token-value' })); expect(r.status).toBe(503); expect((await shape(r)).code).toBe('NOT_DEPLOYED') })
  it('GET is 405', async () => expect((await call('right-token-value', undefined, 'GET')).status).toBe(405))
  it('safeEqual is exact', () => { expect(safeEqual('a', 'a')).toBe(true); expect(safeEqual('a', 'b')).toBe(false); expect(safeEqual('a', 'ab')).toBe(false); expect(safeEqual('', '')).toBe(true) })
})

describe('GET /api/state and the error wrapper', () => {
  it('without a contract it is 503 NOT_DEPLOYED with the error shape', async () => { const r = await state(ctx(new Request('https://t.test/api/state'), env())); expect(r.status).toBe(503); expect((await shape(r)).code).toBe('NOT_DEPLOYED') })
  it('POST is 405', async () => expect((await state(ctx(new Request('https://t.test/api/state', { method: 'POST' }), env()))).status).toBe(405))
  it('an unexpected exception is a 500 INTERNAL that leaks nothing', async () => {
    const h = handle(async () => { throw new Error('postgres://user:pass@host exploded: stack trace here') })
    const r = await h(ctx(new Request('https://t.test/x'), env()))
    const j = await shape(r)
    expect(r.status).toBe(500)
    expect(j.code).toBe('INTERNAL')
    expect(JSON.stringify(j)).not.toMatch(/postgres|stack|pass/)
  })
  it('ApiError carries its status, code and retry-after', async () => {
    const r = await handle(async () => { throw new ApiError(429, 'RATE_LIMITED', 'slow down', 7) })(ctx(new Request('https://t.test/x'), env()))
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBe('7')
  })
})
