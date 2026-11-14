// EIP-191 (personal_sign) sign-in for Ethereum-implicit 0x accounts: nonce text, verify rules, both endpoints.
import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ctx, env, MemKV } from './helpers'
import { onRequest as nonceApi } from '../functions/api/auth/nonce'
import { onRequest as verifyApi } from '../functions/api/auth/verify'
import { checkAccountId, issueNonce, verifyAuth, type AuthDeps } from '../functions/_lib/nep413Auth'
import { Rpc } from '../src/game/chain/rpc'

const HOST = 'title-shot.pages.dev'
const acct = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
const ID = acct.address.toLowerCase()

const world = () => {
  const calls: unknown[] = []
  const fetchFn = (async (...a: unknown[]) => { calls.push(a); return new Response('{}') }) as unknown as typeof fetch
  const deps: AuthDeps = { kv: new MemKV(), rpc: new Rpc({ urls: ['https://rpc.test'], fetchFn }), now: () => 1_000_000 }
  return { deps, calls }
}
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => `${e.status}:${e.code}`)

async function signed(deps: AuthDeps, over: { signer?: typeof acct; recipient?: string; guestId?: string } = {}) {
  const issued = await issueNonce(deps, { accountId: ID, guestId: over.guestId }, over.recipient ?? HOST)
  const signature = await (over.signer ?? acct).signMessage({ message: issued.message })
  return { scheme: 'eip191' as const, accountId: ID, signature, nonce: issued.nonce, recipient: issued.recipient, message: issued.message }
}

describe('0x accounts: nonce', () => {
  it('accepts lowercase 0x, refuses uppercase or mixed case as BAD_ACCOUNT', () => {
    expect(() => checkAccountId(ID)).not.toThrow()
    expect(() => checkAccountId(acct.address)).toThrow(/lowercase/)
    expect(() => checkAccountId('0x' + 'A'.repeat(40))).toThrow(/lowercase/)
    expect(() => checkAccountId('0x' + 'a'.repeat(39))).toThrow()
  })

  it('binds the domain and nonce in the text and reports scheme eip191; NEP-413 accounts stay nep413', async () => {
    const { deps } = world()
    const a = await issueNonce(deps, { accountId: ID, guestId: 'g_7' }, HOST)
    expect(a.scheme).toBe('eip191')
    expect(a.message).toBe(`Title Shot: I control ${ID} and want demo account g_7 moved here.\nDomain: ${HOST}\nNonce: ${a.nonce}`)
    const b = await issueNonce(deps, { accountId: 'alice.testnet' }, HOST)
    expect(b.scheme).toBe('nep413')
    expect(b.message).toBe('Title Shot: I control alice.testnet.')
  })
})

describe('0x accounts: verify', () => {
  it('a valid personal_sign passes with no RPC call', async () => {
    const { deps, calls } = world()
    expect(await verifyAuth(deps, await signed(deps), HOST)).toEqual({ ok: true, accountId: ID, scheme: 'eip191' })
    expect(calls.length).toBe(0)
  })

  it('a replay is NONCE_UNKNOWN', async () => {
    const { deps } = world()
    const b = await signed(deps)
    await verifyAuth(deps, b, HOST)
    expect(await code(verifyAuth(deps, b, HOST))).toBe('401:NONCE_UNKNOWN')
  })

  it('a signature by a different address is BAD_SIGNATURE, a malformed one too, and the nonce is burned', async () => {
    const { deps } = world()
    const b = await signed(deps, { signer: other })
    expect(await code(verifyAuth(deps, b, HOST))).toBe('401:BAD_SIGNATURE')
    expect(await code(verifyAuth(deps, b, HOST))).toBe('401:NONCE_UNKNOWN')
    const c = await signed(deps)
    expect(await code(verifyAuth(deps, { ...c, signature: '0x' + '00'.repeat(65) }, HOST))).toBe('401:BAD_SIGNATURE')
  })

  it('the wrong recipient, message or account is refused', async () => {
    const { deps } = world()
    expect(await code(verifyAuth(deps, { ...(await signed(deps)), recipient: 'evil.example' }, HOST))).toBe('401:WRONG_RECIPIENT')
    expect(await code(verifyAuth(deps, await signed(deps, { recipient: 'localhost' }), HOST))).toBe('401:WRONG_RECIPIENT')
    expect(await code(verifyAuth(deps, { ...(await signed(deps)), message: 'other' }, HOST))).toBe('401:WRONG_MESSAGE')
    expect(await code(verifyAuth(deps, { ...(await signed(deps)), accountId: other.address.toLowerCase() }, HOST))).toBe('401:WRONG_ACCOUNT')
  })

  it('malformed signature shape is 400; a 0x account with a NEP-413 body is 400 BAD_INPUT', async () => {
    const { deps } = world()
    expect(await code(verifyAuth(deps, { ...(await signed(deps)), signature: '0x12' }, HOST))).toBe('400:BAD_INPUT')
    const nep = { accountId: ID, publicKey: 'ed25519:' + '1'.repeat(44), signature: 'A'.repeat(86), nonce: 'A'.repeat(43) + '=', recipient: HOST, message: 'x' }
    expect(await code(verifyAuth(deps, nep, HOST))).toBe('400:BAD_INPUT')
    expect(await code(verifyAuth(deps, { ...nep, scheme: 'nep413' }, HOST))).toBe('400:BAD_INPUT')
  })
})

describe('0x accounts: endpoints', () => {
  const post = (path: string, body: unknown) => new Request(`https://${HOST}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '6.6.6.6' } })

  it('nonce -> personal_sign -> verify end to end, then replay is { error, code }', async () => {
    const e = env()
    const r = await nonceApi(ctx(post('/api/auth/nonce', { accountId: ID, guestId: 'g1' }), e))
    expect(r.status).toBe(200)
    const n = (await r.json()) as { nonce: string; message: string; recipient: string; expiresAt: number; scheme: string }
    expect(n.scheme).toBe('eip191')
    expect(n.message).toContain(`\nDomain: ${HOST}\nNonce: ${n.nonce}`)
    const body = { scheme: 'eip191', accountId: ID, signature: await acct.signMessage({ message: n.message }), nonce: n.nonce, recipient: n.recipient, message: n.message }
    const ok = await verifyApi(ctx(post('/api/auth/verify', body), e))
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, accountId: ID, scheme: 'eip191' }])
    const replay = await verifyApi(ctx(post('/api/auth/verify', body), e))
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'This sign-in request expired or was already used. Try again.', code: 'NONCE_UNKNOWN' })
  })

  it('uppercase 0x at nonce time is 400 BAD_ACCOUNT', async () => {
    const r = await nonceApi(ctx(post('/api/auth/nonce', { accountId: acct.address }), env()))
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([400, 'BAD_ACCOUNT'])
  })
})
