// Fetch NEAR AI Cloud attestation reports (public, no key) and print/record a summary:
// which models are TEE-attested and their signing addresses.
// usage: node attest-summary.mjs <model> [<model> ...]   (writes vectors/attestation-<slug>.json)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.NEARAI_BASE || 'https://cloud-api.near.ai';
const models = process.argv.slice(2);
if (!models.length) models.push('Qwen/Qwen3.8-27B');

const short = (v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + '...(' + v.length + ' chars)' : v);
function summarize(o) {
  if (Array.isArray(o)) return o.map(summarize);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, summarize(v)]));
  return short(o);
}

mkdirSync(join(root, 'vectors'), { recursive: true });
for (const model of models) {
  const url = `${BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  const t0 = Date.now();
  const res = await fetch(url);
  const ms = Date.now() - t0;
  const body = await res.text();
  let j;
  try { j = JSON.parse(body); } catch { j = { raw: body.slice(0, 200) }; }
  const signers = {
    gateway: j.gateway_attestation?.signing_address ?? null,
    model: (j.model_attestations ?? []).map((m) => ({
      model_name: m.model_name, signing_address: m.signing_address,
      has_intel_quote: !!m.intel_quote, has_nvidia_payload: !!m.nvidia_payload,
    })),
  };
  const out = { model, http: res.status, ms, tee_attested: res.ok && signers.model.length > 0, signers, summary: summarize(j) };
  const slug = model.replace(/[^A-Za-z0-9.]+/g, '_');
  writeFileSync(join(root, 'vectors', `attestation-${slug}.json`), JSON.stringify(out, null, 2));
  console.log(model, res.status, ms + 'ms');
  console.log(JSON.stringify({ tee_attested: out.tee_attested, signers, error: res.ok ? undefined : out.summary }));
}
