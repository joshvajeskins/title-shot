// Record a real NEAR AI Cloud response + signature as a replayable vector.
//   node scripts/record-vector.mjs --model <id> [--sentence "..."] [--n 1] [--parts parts.json]
//        [--out-dir vectors] [--base https://cloud-api.near.ai] [--max-tokens 300]
// parts.json = {"prefix": "...", "suffix": "..."}: the exact bytes before/after the escaped sentence
// (swap in crates/bout-sim request_parts(model_id) output; "{{MODEL}}" is replaced by --model).
// Needs NEARAI_API_KEY (env or repo .env.local). Without it: prints NOT RUN and exits 2.
// The key is never printed or written. Output: vectors/nearai-<model>-<n>.json (cases = recorded
// valid case + key-free derived negatives), verified offline (noble) before writing.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfgOf, verifyForge, deriveNegatives, requestBytes, sha256Hex, jsonEscape } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const model = arg('model');
if (!model) { console.error('usage: record-vector.mjs --model <id> [--sentence ..] [--n 1] [--parts f] [--out-dir d]'); process.exit(1); }
const BASE = arg('base', process.env.NEARAI_BASE || 'https://cloud-api.near.ai');
const n = arg('n', '1');
const outDir = arg('out-dir', join(root, 'vectors'));
const sentence = arg('sentence', 'I fight like a cornered badger with a grudge and a very good lawyer');
const maxTokens = Number(arg('max-tokens', '300'));

function loadKey() {
  if (process.env.NEARAI_API_KEY) return process.env.NEARAI_API_KEY;
  const p = join(root, '.env.local');
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*NEARAI_API_KEY\s*=\s*(.*)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '') || null;
  }
  return null;
}
const key = loadKey();
if (!key) { console.log('real vector: NOT RUN (NEARAI_API_KEY missing from env and .env.local)'); process.exit(2); }

function parts() {
  const pf = arg('parts');
  if (pf) {
    const j = JSON.parse(readFileSync(pf, 'utf8'));
    return [j.prefix.replaceAll('{{MODEL}}', model), j.suffix.replaceAll('{{MODEL}}', model)];
  }
  // Placeholder rulebook: strict json_schema {"ok": boolean}.
  const head = {
    model, stream: false, temperature: 0, max_tokens: maxTokens,
    response_format: { type: 'json_schema', json_schema: { name: 'ok', strict: true,
      schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } } },
    messages: [{ role: 'system', content: 'Return JSON {"ok":true}' }, { role: 'user', content: '@@S@@' }],
  };
  return JSON.stringify(head).split('@@S@@');
}
const [prefix, suffix] = parts();
const body = requestBytes(prefix, suffix, sentence);
const parsed = JSON.parse(body); // must be valid JSON
const sentBack = parsed.messages.at(-1).content;
if (sentBack !== sentence) throw new Error('request template does not round-trip the sentence');
const bodyBytes = Buffer.from(body, 'utf8');
const reqHash = sha256Hex(bodyBytes);

const auth = { Authorization: `Bearer ${key}` };
const timed = async (url, init) => { const t = Date.now(); const r = await fetch(url, init); const b = Buffer.from(await r.arrayBuffer()); return { r, b, ms: Date.now() - t }; };

// attestation (public) for the signer addresses
let attested = { gateway: null, model: null };
try {
  const a = await timed(`${BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: auth });
  const aj = JSON.parse(a.b.toString('utf8'));
  attested = { gateway: aj.gateway_attestation?.signing_address ?? null,
    model: (aj.model_attestations ?? []).find((m) => m.model_name === model)?.signing_address ?? null };
} catch (e) { attested.error = String(e.message ?? e); }

const c = await timed(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
  body: bodyBytes,
});
if (!c.r.ok) { console.error('chat HTTP', c.r.status, c.b.toString('utf8').slice(0, 400)); process.exit(3); }
if (c.r.headers.get('content-encoding')) console.warn('WARN: response content-encoding =', c.r.headers.get('content-encoding'));
const response = c.b.toString('utf8');
if (!Buffer.from(response, 'utf8').equals(c.b)) throw new Error('response is not round-trip UTF-8; cannot store as string');
const chatId = JSON.parse(response).id;
const respHash = sha256Hex(c.b);

let sig = null, sigMs = 0, sigTries = 0;
for (let i = 0; i < 8 && !sig; i++) {
  sigTries++;
  const s = await timed(`${BASE}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: auth });
  sigMs += s.ms;
  if (s.r.ok) sig = JSON.parse(s.b.toString('utf8'));
  else { console.warn('signature HTTP', s.r.status, s.b.toString('utf8').slice(0, 200)); await new Promise((r) => setTimeout(r, 1000)); }
}
if (!sig) { console.error('no signature obtained'); process.exit(4); }

const parts3 = sig.text.split(':');
const kind = sig.signature_kind ?? (sig.text.startsWith(model + ':') ? 'provider_tee' : parts3.length === 2 ? 'gateway' : 'unknown');
const textParts = sig.text.split(':');
const report = {
  signature_kind: kind,
  signing_address: sig.signing_address,
  signer_matches_attested_model: attested.model ? attested.model.toLowerCase() === sig.signing_address.toLowerCase() : null,
  signer_matches_attested_gateway: attested.gateway ? attested.gateway.toLowerCase() === sig.signing_address.toLowerCase() : null,
  request_hash_equals_sha256_of_sent_bytes: textParts.at(-2) === reqHash,
  response_hash_equals_sha256_of_received_bytes: textParts.at(-1) === respHash,
  text_has_model_prefix: sig.text.startsWith(model + ':'),
  completion_ms: c.ms, signature_fetch_ms: sigMs, signature_fetch_attempts: sigTries,
  response_bytes: c.b.length, request_bytes: bodyBytes.length,
  json_schema_strict_ok: (() => { try { JSON.parse(JSON.parse(response).choices[0].message.content); return true; } catch { return false; } })(),
};

const base = {
  name: 'recorded_real_response', sentence, response,
  signature_hex: sig.signature, signing_algo: sig.signing_algo ?? 'ecdsa', signature_kind: kind,
};
const vec = {
  kind: 'nearai-real', recorded_at: new Date().toISOString(), chat_id: chatId, model_id: model, base_url: BASE,
  attested_signers: attested, signature_text: sig.text, report,
  allowlist: [sig.signing_address],
  prefix_b64: Buffer.from(prefix).toString('base64'), suffix_b64: Buffer.from(suffix).toString('base64'),
  cases: [],
};
const cfg = cfgOf(vec);
const first = verifyForge(cfg, base);
base.expect = { ok: first.ok, code: first.code, content: first.content ?? null };
vec.cases = [base, ...deriveNegatives(base)];
vec.report.offline_verify = first;
for (const k of vec.cases.slice(1)) {
  const g = verifyForge(cfg, k);
  if (g.code !== k.expect.code) throw new Error(`derived negative ${k.name}: node says ${g.code}, expected ${k.expect.code}`);
}
mkdirSync(outDir, { recursive: true });
const slug = model.replace(/[^A-Za-z0-9.]+/g, '_');
const path = join(outDir, `nearai-${slug}-${n}.json`);
writeFileSync(path, JSON.stringify(vec, null, 2) + '\n');
console.log(JSON.stringify({ wrote: path, ...report, offline: first.code }, null, 2));
if (!first.ok) { console.error('offline verification of the recorded signature FAILED:', first.code, '(see report; vector saved for diagnosis)'); process.exit(5); }
