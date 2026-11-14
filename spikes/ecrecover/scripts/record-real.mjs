// Record ONE real NEAR AI compile with the production request bytes (bout-sim build_request), its signature,
// a local verification and its priced cost. Usage (from spikes/ecrecover):
//   node scripts/record-real.mjs --model z-ai/glm-5.3-flash --sentence "a pigeon with a law degree" --slug pigeon
// The API key is read from ../../.env.local and never printed or written.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import init, * as sim from '../../../web/src/sim/pkg/bout_sim.js'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const model = arg('model'), sentence = arg('sentence'), slug = arg('slug', 'v')
if (!model || !sentence) { console.error('need --model and --sentence'); process.exit(2) }
const PRICES = { 'z-ai/glm-5.3-flash': [0.08, 0.5], 'Qwen/Qwen3.8-27B': [0.04, 1.35], 'deepseek-ai/DeepSeek-V4.1-Flash-1017': [0.3, 1.2] }
const env = Object.fromEntries(readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]))
const KEY = env.NEARAI_API_KEY
if (!KEY) { console.error('NEARAI_API_KEY missing'); process.exit(2) }
await init({ module_or_path: readFileSync(new URL('../../../web/src/sim/pkg/bout_sim_bg.wasm', import.meta.url)) })

const sha = (b) => createHash('sha256').update(b).digest('hex')
const REASONING = { 'z-ai/glm-5.3-flash': '"reasoning_effort":"low",', 'Qwen/Qwen3.8-27B': '"chat_template_kwargs":{"enable_thinking":false},' }
let body = sim.build_request(model, sentence)
if (process.argv.includes('--reasoning-off') && REASONING[model]) body = body.replace('"temperature":0,', REASONING[model] + '"temperature":0,')
const req = Buffer.from(body, 'utf8')
const base = 'https://cloud-api.near.ai/v1'
const t0 = Date.now()
const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'accept-encoding': 'identity' }, body: req })
const resp = Buffer.from(await res.arrayBuffer())
const t1 = Date.now()
if (!res.ok) { console.error('HTTP', res.status, resp.toString('utf8').slice(0, 300)); process.exit(1) }
const j = JSON.parse(resp.toString('utf8'))
const sres = await fetch(`${base}/signature/${encodeURIComponent(j.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${KEY}` } })
const sig = await sres.json()
const t2 = Date.now()

// local verification: text binding + EIP-191 recovery
const reqH = sha(req), respH = sha(resp)
const expect = { provider_tee: `${model}:${reqH}:${respH}`, gateway: `${reqH}:${respH}` }
const kind = sig.signature_kind ?? (sig.text === expect.provider_tee ? 'provider_tee' : sig.text === expect.gateway ? 'gateway' : 'unknown')
const msg = Buffer.from(sig.text ?? '', 'utf8')
const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]))
const s = Buffer.from((sig.signature ?? '').replace(/^0x/, ''), 'hex')
let recovered = null
try { let v = s[64]; if (v >= 27) v -= 27; const pub = secp256k1.Signature.fromCompact(s.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false); recovered = '0x' + Buffer.from(keccak_256(pub.subarray(1)).slice(12)).toString('hex') } catch { /* reported below */ }

const usage = j.usage ?? {}
const [pin, pout] = PRICES[model] ?? [0, 0]
const usd = ((usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout) / 1e6
const content = j.choices?.[0]?.message?.content ?? null
let norm = null
try { norm = JSON.parse(sim.normalize(content ?? '')) } catch (e) { norm = { ok: false, error: String(e) } }
const out = { model, sentence, request_utf8: req.toString('utf8'), response_utf8: resp.toString('utf8'), signature: sig, request_sha256: reqH, response_sha256: respH, signature_kind: kind, text_matches: sig.text === expect.provider_tee || sig.text === expect.gateway, recovered, signer_matches: recovered?.toLowerCase() === String(sig.signing_address ?? '').toLowerCase(), usage, usd, latency_ms: { completion: t1 - t0, signature: t2 - t1 }, recorded_at: new Date().toISOString() }
writeFileSync(new URL(`../../../vectors/nearai-real-${model.replace(/[^a-z0-9]/gi, '_')}-${slug}.json`, import.meta.url), JSON.stringify(out, null, 1))
console.log(JSON.stringify({ http: res.status, kind, text_matches: out.text_matches, signer: sig.signing_address, signer_matches: out.signer_matches, usage, usd: usd.toFixed(6), latency_ms: out.latency_ms, finish: j.choices?.[0]?.finish_reason, content_chars: content?.length ?? 0, normalize: norm?.ok ? { name: norm.spec.name, title: norm.spec.title, school: norm.spec.school, style: norm.spec.style, moves: norm.spec.moves.map((m) => `${m.id}:${m.label}`), cry: norm.spec.cry } : norm }, null, 1))
