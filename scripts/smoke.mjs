#!/usr/bin/env node
// End-to-end smoke test against a running Pages deployment (preview URL or `scripts/dev-pages.sh` on :8788).
//   node scripts/smoke.mjs https://title-shot.pages.dev
// Optional env: TICK_SECRET (also exercises /api/tick), SMOKE_GUEST=1 (creates a real guest: spends sponsor NEAR),
// SMOKE_SENTENCE (preview input). Exit code 1 if any check fails.
const base = (process.argv[2] ?? process.env.URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const call = async (path, init) => { const r = await fetch(base + path, init); let j = null; try { j = await r.clone().json() } catch { /* binary */ } return { r, j } }
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const errShape = (j) => j && typeof j.error === 'string' && typeof j.code === 'string'

// ---- state
const st = await call('/api/state')
const deployed = st.r.status === 200
check('GET /api/state answers', st.r.status === 200 || (st.r.status === 503 && st.j?.code === 'NOT_DEPLOYED'), `HTTP ${st.r.status} ${st.j?.code ?? ''}`)
if (deployed) {
  check('state has belts, fights, wallets', Array.isArray(st.j.belts) && Array.isArray(st.j.fights) && Array.isArray(st.j.wallets), `${st.j.belts?.length} belts, ${st.j.fights?.length} fights`)
  const b = st.j.belts[0]
  if (b) check('belt is UI-shaped (champion, season, purse)', !!b.champion?.spec?.name && !!b.season && typeof b.tollYocto === 'string', b.name)
}

// ---- input validation (hostile inputs never 500)
const bad = [
  ['preview: not JSON', () => post('/api/preview', '{nope'), 400],
  ['preview: wrong shape', () => post('/api/preview', { sentence: 42 }), 400],
  ['preview: extra field', () => post('/api/preview', { sentence: 'a goose', admin: true }), 400],
  ['preview: too short', () => post('/api/preview', { sentence: 'ab' }), 400],
  ['preview: too long', () => post('/api/preview', { sentence: 'x'.repeat(200) }), 400],
  ['preview: GET refused', () => call('/api/preview'), 405],
  ['guest: bad key', () => post('/api/guest', { publicKey: 'nope', sessionKey: 'nope' }), 400],
  ['guest: same key twice', () => post('/api/guest', { publicKey: 'ed25519:' + '1'.repeat(44), sessionKey: 'ed25519:' + '1'.repeat(44) }), 400],
  ['portrait: bad hash', () => call('/api/portrait/not-a-hash'), 400],
  ['cry: bad hash', () => call('/api/cry/' + 'z'.repeat(64)), 400],
  ['tick: no token', () => post('/api/tick', {}), 401],
  ['tick: wrong token', () => post('/api/tick', {}, { 'x-tick-secret': 'wrong' }), 401],
]
for (const [name, fn, want] of bad) {
  const { r, j } = await fn()
  check(name, r.status === want && errShape(j), `HTTP ${r.status}${j?.code ? ' ' + j.code : ''}`)
}
const unknown = await call('/api/portrait/' + '0'.repeat(63) + '1')
check('portrait: unknown fighter is a clean 404', unknown.r.status === 404 && errShape(unknown.j), `HTTP ${unknown.r.status} ${unknown.j?.code ?? ''}`)

// ---- preview (needs NEARAI_API_KEY on the server; a 503 AI_UNAVAILABLE is reported, not failed)
const sentence = process.env.SMOKE_SENTENCE ?? 'a very polite kraken who files taxes'
const pv = await post('/api/preview', { sentence })
if (pv.r.status === 200) {
  check('preview returns a spec', !!pv.j.spec?.name && pv.j.spec.moves?.length === 3, `${pv.j.spec?.name} canonical=${pv.j.canonical}`)
  if (!pv.j.canonical) check(`preview carries a verified signature (compiler: ${pv.j.compiler ?? 'unknown'})`, pv.j.verified === true && !!pv.j.signature?.signature, `signer ${pv.j.signer}`)
  const pt = await call(pv.j.portrait)
  check('portrait endpoint answers (image or clean 404)', pt.r.status === 200 ? (pt.r.headers.get('content-type') ?? '').startsWith('image/') : pt.r.status === 404 && errShape(pt.j), `HTTP ${pt.r.status}`)
  const cry = await call('/api/cry/' + pv.j.hash)
  check('cry endpoint answers (mp3 or clean error)', cry.r.status === 200 ? (cry.r.headers.get('content-type') ?? '').includes('audio') : errShape(cry.j), `HTTP ${cry.r.status} ${cry.j?.code ?? ''}`)
} else check('preview answers cleanly without the AI key', errShape(pv.j) && [503, 502, 422].includes(pv.r.status), `HTTP ${pv.r.status} ${pv.j?.code ?? ''}`)

// ---- tick (only with the token)
if (process.env.TICK_SECRET) {
  const t = await post('/api/tick', {}, { 'x-tick-secret': process.env.TICK_SECRET })
  check('tick runs', t.r.status === 200 && Array.isArray(t.j.steps), `${t.j?.skipped ?? ''} ${t.j?.steps?.map((s) => s.action + (s.ok ? '' : '!')).join(',')}`)
}

// ---- guest (spends real testnet NEAR from the sponsor: opt in with SMOKE_GUEST=1)
if (process.env.SMOKE_GUEST === '1') {
  const { ed25519 } = await import(new URL('../web/node_modules/@noble/curves/ed25519.js', import.meta.url).href)
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const b58 = (bytes) => { let n = 0n; for (const x of bytes) n = (n << 8n) | BigInt(x); let o = ''; while (n > 0n) { o = ALPHA[Number(n % 58n)] + o; n /= 58n } for (const x of bytes) { if (x === 0) o = '1' + o; else break } return o }
  const pub = () => 'ed25519:' + b58(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
  const g = await post('/api/guest', { publicKey: pub(), sessionKey: pub() })
  check('guest account is created and funded', g.r.status === 200 && /\.play\.titleshot\.testnet$/.test(g.j?.accountId ?? ''), g.j?.accountId ?? `HTTP ${g.r.status} ${g.j?.code ?? ''}`)
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed against ${base}`)
process.exit(failed ? 1 : 0)
