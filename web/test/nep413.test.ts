// NEP-413 sign-in: hash layout, nonce lifecycle, key checks and the two endpoints.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ctx, env, MemKV } from './helpers'
import { onRequest as nonceApi } from '../functions/api/auth/nonce'
import { onRequest as verifyApi } from '../functions/api/auth/verify'
import { nep413Hash, nep413PreImage, signNep413, verifyNep413Signature } from '../functions/_lib/nep413'
import { issueNonce, verifyAuth, type AuthDeps } from '../functions/_lib/nep413Auth'
import { fromB64, toB64 } from '../src/game/chain/bytes'
import { Rpc } from '../src/game/chain/rpc'
import { formatPublicKey, generateKeyPair } from '../src/game/chain/keys'

const HOST = 'title-shot.pages.dev'
const kp = generateKeyPair()
const pk = formatPublicKey(kp.publicKey)
const ACCOUNT = 'alice.testnet'

type Permission = 'FullAccess' | { FunctionCall: Record<string, unknown> }
/** A fake NEAR RPC: `keys` maps "account|publicKey" to a permission; anything else is UNKNOWN_ACCESS_KEY. */
function fakeRpc(keys: Record<string, Permission>, down = false): { fetchFn: typeof fetch; calls: any[] } {
  const calls: any[] = []
  const fetchFn = (async (_u: string, init: RequestInit) => {
    if (down) return new Response('x', { status: 503 })
    const { params, id } = JSON.parse(String(init.body))
    calls.push(params)
    const perm = keys[`${params.account_id}|${params.public_key}`]
    if (!perm) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' }, message: 'nope' } }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { nonce: 1, permission: perm } }))
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const world = (keys: Record<string, Permission> = { [`${ACCOUNT}|${pk}`]: 'FullAccess' }, down = false) => {
  const rpc = fakeRpc(keys, down)
  const clock = { t: 1_000_000 }
  const deps: AuthDeps = { kv: new MemKV(), rpc: new Rpc({ urls: ['https://rpc.test'], fetchFn: rpc.fetchFn }), now: () => clock.t }
  return { deps, rpc, clock }
}

/** The wallet side: ask for a nonce, sign it, build the verify body. */
async function signedBody(deps: AuthDeps, over: { accountId?: string; guestId?: string; recipient?: string; sigRecipient?: string } = {}) {
  const accountId = over.accountId ?? ACCOUNT
  const issued = await issueNonce(deps, { accountId, guestId: over.guestId }, over.recipient ?? HOST)
  const recipient = over.sigRecipient ?? issued.recipient
  const signature = signNep413(kp, { message: issued.message, nonce: fromB64(issued.nonce), recipient, callbackUrl: null })
  return { accountId, publicKey: pk, signature, nonce: issued.nonce, recipient, message: issued.message, callbackUrl: null }
}

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => `${e.status}:${e.code}`)

describe('NEP-413 hash', () => {
  it('pre-image starts with the tag 2147484061 little-endian (9d 01 00 80) and lays out Payload in borsh order', () => {
    const nonce = Uint8Array.from({ length: 32 }, (_, i) => i)
    const pre = nep413PreImage({ message: 'hi', nonce, recipient: 'myapp.com', callbackUrl: 'myapp.com/callback' })
    expect(Array.from(pre.slice(0, 4))).toEqual([0x9d, 0x01, 0x00, 0x80])
    expect(Array.from(pre.slice(4, 10))).toEqual([2, 0, 0, 0, 0x68, 0x69]) // string: u32 length + bytes
    expect(Array.from(pre.slice(10, 42))).toEqual(Array.from(nonce)) // fixed array: no length prefix
    expect(pre[42]).toBe(9) // recipient length
    expect(pre.length).toBe(4 + 6 + 32 + 4 + 9 + 1 + 4 + 18) // Some(callbackUrl) = tag 1 + string
    expect(nep413Hash({ message: 'hi', nonce, recipient: 'myapp.com' }).length).toBe(32)
    expect(nep413PreImage({ message: 'hi', nonce, recipient: 'myapp.com', callbackUrl: null }).at(-1)).toBe(0) // None
  })

  it('verifies a good signature; rejects wrong length, junk and a different payload', () => {
    const p = { message: 'm', nonce: new Uint8Array(32).fill(7), recipient: HOST }
    const sig = signNep413(kp, p)
    expect(verifyNep413Signature(p, pk, sig)).toBe(true)
    expect(verifyNep413Signature({ ...p, message: 'x' }, pk, sig)).toBe(false)
    expect(verifyNep413Signature(p, pk, toB64(fromB64(sig).slice(0, 63)))).toBe(false)
    expect(verifyNep413Signature(p, pk, '!!!')).toBe(false)
    expect(verifyNep413Signature(p, 'ed25519:abc', sig)).toBe(false)
  })
})

describe('issueNonce / verifyAuth', () => {
  it('issues a 32-byte nonce, the message (with and without a guest) and a 5 minute expiry, stored with a TTL', async () => {
    const { deps } = world()
    const a = await issueNonce(deps, { accountId: ACCOUNT }, HOST)
    expect(fromB64(a.nonce).length).toBe(32)
    expect(a.message).toBe('Title Shot: I control alice.testnet.')
    expect(a.expiresAt).toBe(1_000_000 + 300_000)
    const b = await issueNonce(deps, { accountId: ACCOUNT, guestId: 'g_42' }, HOST)
    expect(b.message).toBe('Title Shot: I control alice.testnet and want guest corner g_42 moved here.')
    expect([...(deps.kv as MemKV).store.keys()].every((k) => k.startsWith('auth-nonce:'))).toBe(true)
  })

  it('a valid signature from a full-access key passes (callbackUrl too)', async () => {
    const { deps, rpc } = world()
    expect(await verifyAuth(deps, await signedBody(deps), HOST)).toEqual({ ok: true, accountId: ACCOUNT, publicKey: pk })
    expect(rpc.calls[0]).toMatchObject({ request_type: 'view_access_key', finality: 'final', account_id: ACCOUNT, public_key: pk })
  })

  it('a replay of the same signed payload is refused (NONCE_UNKNOWN), also when KV still has the record', async () => {
    const { deps } = world()
    const body = await signedBody(deps)
    expect((await verifyAuth(deps, body, HOST)).ok).toBe(true)
    expect(await code(verifyAuth(deps, body, HOST))).toBe('401:NONCE_UNKNOWN')
    const again = await signedBody(deps)
    const kv = deps.kv as MemKV
    const saved = new Map(kv.store)
    await verifyAuth(deps, again, HOST)
    kv.store = saved // KV lag: the record reappears, the isolate memory still refuses
    expect(await code(verifyAuth(deps, again, HOST))).toBe('401:NONCE_UNKNOWN')
  })

  it('a failed attempt still burns the nonce', async () => {
    const { deps } = world()
    const body = await signedBody(deps)
    expect(await code(verifyAuth(deps, { ...body, message: 'other' }, HOST))).toBe('401:WRONG_MESSAGE')
    expect(await code(verifyAuth(deps, body, HOST))).toBe('401:NONCE_UNKNOWN')
  })

  it('an unknown or expired nonce is refused', async () => {
    const { deps, clock } = world()
    const body = await signedBody(deps)
    clock.t += 301_000
    expect(await code(verifyAuth(deps, body, HOST))).toBe('401:NONCE_UNKNOWN')
    expect(await code(verifyAuth(deps, { ...(await signedBody(deps)), nonce: toB64(new Uint8Array(32).fill(1)) }, HOST))).toBe('401:NONCE_UNKNOWN')
  })

  it('the wrong recipient is refused: a different site, a signature over another recipient, localhost from a real host', async () => {
    const { deps } = world()
    expect(await code(verifyAuth(deps, await signedBody(deps, { sigRecipient: 'evil.example' }), HOST))).toBe('401:WRONG_RECIPIENT')
    expect(await code(verifyAuth(deps, await signedBody(deps, { recipient: 'evil.example' }), HOST))).toBe('401:WRONG_RECIPIENT')
    expect(await code(verifyAuth(deps, await signedBody(deps, { recipient: 'localhost' }), HOST))).toBe('401:WRONG_RECIPIENT')
    expect(await code(verifyAuth(deps, await signedBody(deps, { recipient: 'a.b.title-shot.pages.dev' }), HOST))).toBe('401:WRONG_RECIPIENT')
  })

  it('preview aliases are accepted; localhost only for a localhost request', async () => {
    const { deps } = world()
    expect((await verifyAuth(deps, await signedBody(deps, { recipient: 'wallets.title-shot.pages.dev' }), HOST)).ok).toBe(true)
    expect((await verifyAuth(deps, await signedBody(deps, { recipient: 'localhost' }), 'localhost')).ok).toBe(true)
    expect((await verifyAuth(deps, await signedBody(deps, { recipient: '127.0.0.1' }), '127.0.0.1')).ok).toBe(true)
  })

  it('a function-call key is refused', async () => {
    const { deps } = world({ [`${ACCOUNT}|${pk}`]: { FunctionCall: { allowance: '1', receiver_id: 'x.testnet', method_names: [] } } })
    expect(await code(verifyAuth(deps, await signedBody(deps), HOST))).toBe('401:NOT_FULL_ACCESS')
  })

  it('the wrong account is refused: nonce for another account, and a key that is not on the account', async () => {
    const { deps } = world()
    const body = await signedBody(deps, { accountId: 'bob.testnet' })
    expect(await code(verifyAuth(deps, { ...body, accountId: ACCOUNT }, HOST))).toBe('401:WRONG_ACCOUNT')
    const stranger = world({}) // the chain knows no such key
    expect(await code(verifyAuth(stranger.deps, await signedBody(stranger.deps), HOST))).toBe('401:KEY_NOT_ON_ACCOUNT')
  })

  it('a missing key reported the older way (a result carrying an `error` string, as live testnet RPCs answer) is KEY_NOT_ON_ACCOUNT', async () => {
    const fetchFn = (async (_u: string, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { block_height: 1, block_hash: 'x', error: `access key ${pk} does not exist while viewing`, logs: [] } }))
    }) as unknown as typeof fetch
    const deps: AuthDeps = { kv: new MemKV(), rpc: new Rpc({ urls: ['https://rpc.test'], fetchFn }) }
    expect(await code(verifyAuth(deps, await signedBody(deps), HOST))).toBe('401:KEY_NOT_ON_ACCOUNT')
  })

  it('a tampered message or signature is refused', async () => {
    const { deps } = world()
    expect(await code(verifyAuth(deps, { ...(await signedBody(deps)), message: 'Title Shot: I control mallory.testnet.' }, HOST))).toBe('401:WRONG_MESSAGE')
    const b = await signedBody(deps)
    const bad = fromB64(b.signature); bad[0] = bad[0]! ^ 1
    expect(await code(verifyAuth(deps, { ...b, signature: toB64(bad) }, HOST))).toBe('401:BAD_SIGNATURE')
    const other = generateKeyPair()
    const b2 = await signedBody(deps)
    expect(await code(verifyAuth(deps, { ...b2, publicKey: formatPublicKey(other.publicKey) }, HOST))).toBe('401:BAD_SIGNATURE')
  })

  it('mainnet and non-testnet accounts are refused with WRONG_NETWORK / BAD_ACCOUNT', async () => {
    const { deps } = world()
    expect(await code(issueNonce(deps, { accountId: 'alice.near' }, HOST))).toBe('400:WRONG_NETWORK')
    expect(await code(issueNonce(deps, { accountId: 'Alice.testnet' }, HOST))).toBe('400:BAD_ACCOUNT')
    expect(await code(issueNonce(deps, { accountId: 'alice.example' }, HOST))).toBe('400:BAD_ACCOUNT')
    expect((await issueNonce(deps, { accountId: 'a'.repeat(64) }, HOST)).nonce.length).toBeGreaterThan(0)
    const body = await signedBody(deps)
    expect(await code(verifyAuth(deps, { ...body, accountId: 'alice.near' }, HOST))).toBe('400:WRONG_NETWORK')
  })

  it('RPC down is a 502 CHAIN_UNAVAILABLE', async () => {
    const { deps } = world(undefined, true)
    expect(await code(verifyAuth(deps, await signedBody(deps), HOST))).toBe('502:CHAIN_UNAVAILABLE')
  })

  it('malformed input is a 400 BAD_INPUT', async () => {
    const { deps } = world()
    expect(await code(verifyAuth(deps, { accountId: ACCOUNT }, HOST))).toBe('400:BAD_INPUT')
    expect(await code(verifyAuth(deps, { ...(await signedBody(deps)), signature: 'abc' }, HOST))).toBe('400:BAD_INPUT')
  })
})

describe('/api/auth endpoints', () => {
  afterEach(() => vi.unstubAllGlobals())
  const post = (path: string, body: unknown, host = HOST) => new Request(`https://${host}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.5' } })

  it('nonce -> sign -> verify end to end, then replay is 401 { error, code }', async () => {
    const e = env()
    vi.stubGlobal('fetch', fakeRpc({ [`${ACCOUNT}|${pk}`]: 'FullAccess' }).fetchFn)
    const r = await nonceApi(ctx(post('/api/auth/nonce', { accountId: ACCOUNT, guestId: 'g1' }), e))
    expect(r.status).toBe(200)
    const n = (await r.json()) as { nonce: string; message: string; recipient: string; expiresAt: number }
    expect(n.recipient).toBe(HOST)
    expect(n.message).toBe(`Title Shot: I control ${ACCOUNT} and want guest corner g1 moved here.`)
    const signature = signNep413(kp, { message: n.message, nonce: fromB64(n.nonce), recipient: n.recipient, callbackUrl: null })
    const body = { accountId: ACCOUNT, publicKey: pk, signature, nonce: n.nonce, recipient: n.recipient, message: n.message }
    const ok = await verifyApi(ctx(post('/api/auth/verify', body), e))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, accountId: ACCOUNT, publicKey: pk })
    const replay = await verifyApi(ctx(post('/api/auth/verify', body), e))
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'This sign-in request expired or was already used. Try again.', code: 'NONCE_UNKNOWN' })
  })

  it('nonce: bad host 400 BAD_HOST, mainnet 400 WRONG_NETWORK, bad method 405, bad body 400; localhost serves local dev', async () => {
    const e = env()
    const bad = await nonceApi(ctx(post('/api/auth/nonce', { accountId: ACCOUNT }, 'evil.example'), e))
    expect([bad.status, ((await bad.json()) as any).code]).toEqual([400, 'BAD_HOST'])
    const main = await nonceApi(ctx(post('/api/auth/nonce', { accountId: 'bob.near' }), e))
    expect([main.status, ((await main.json()) as any).code]).toEqual([400, 'WRONG_NETWORK'])
    const get = await nonceApi(ctx(new Request(`https://${HOST}/api/auth/nonce`), e))
    expect(get.status).toBe(405)
    const junk = await nonceApi(ctx(post('/api/auth/nonce', { nope: 1 }), e))
    expect([junk.status, ((await junk.json()) as any).code]).toEqual([400, 'BAD_INPUT'])
    const dev = await nonceApi(ctx(post('/api/auth/nonce', { accountId: ACCOUNT }, 'localhost:8788'), e))
    expect(dev.status).toBe(200)
    expect(((await dev.json()) as any).recipient).toBe('localhost')
  })

  it('nonce issuance is rate limited per IP (30 per 10 minutes)', async () => {
    const e = env()
    let last = 200
    for (let i = 0; i < 31; i++) last = (await nonceApi(ctx(post('/api/auth/nonce', { accountId: ACCOUNT }), e))).status
    expect(last).toBe(429)
  })

  it('verify with an unknown nonce is { error, code } and never raw upstream text', async () => {
    const e = env()
    vi.stubGlobal('fetch', fakeRpc({}, true).fetchFn)
    const b = await signedBody({ kv: e.TS_KV, rpc: new Rpc({ urls: ['https://x'], fetchFn: fakeRpc({}).fetchFn }) })
    const r = await verifyApi(ctx(post('/api/auth/verify', b), e))
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'The chain is not answering. Try again in a moment.', code: 'CHAIN_UNAVAILABLE' })
  })
})
