// Offline verification of every recorded vector with an independent implementation (node + noble). No network, no keys.
// usage: node scripts/verify-offline.mjs [vector.json ...]   (default: every file in vectors/)
// Schemas handled:
//   synthetic-*/nearai-<model>-*.json  case tables from the spike (expected verdict per case)
//   nearai-real-*.json                 real NEAR AI compiles: exact request/response bytes + signature
//   portrait-*.json                    real FLUX portraits: signature over model:sha256(req):sha256(resp)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { cfgOf, verifyForge, jsonEscape } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Signers published in NEAR AI attestation reports (vectors/attestation-*.json), checked on 14 Nov 2026.
const ATTESTED = {
  'z-ai/glm-5.3-flash': '0x3b753b4406613c5e70ae640508632b600424fa0c',
  'black-forest-labs/FLUX.2-klein-4B': '0x98a43dfc25d22e12e774c218cc2051f2e480a803',
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
function recover(text, sigHex) {
  const msg = Buffer.from(text, 'utf8');
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
  const s = Buffer.from(sigHex.replace(/^0x/, ''), 'hex');
  if (s.length !== 65) return null;
  let v = s[64]; if (v >= 27) v -= 27;
  const pub = secp256k1.Signature.fromCompact(s.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return '0x' + Buffer.from(keccak_256(pub.subarray(1)).slice(12)).toString('hex');
}

let total = 0, bad = 0;
const fail = (f, why) => { bad++; console.log(`FAIL ${f}: ${why}`); };

function checkCaseTable(f, vec) {
  const cfg = cfgOf(vec);
  for (const c of vec.cases) {
    total++;
    const got = verifyForge(cfg, c), want = c.expect;
    if (got.code !== want.code || got.ok !== want.ok || (want.ok && got.content !== want.content)) fail(`${f}/${c.name}`, `node=${got.code} want=${want.code}`);
  }
  for (const e of vec.escape_cases ?? []) { total++; if (jsonEscape(e.input) !== e.escaped) fail(f, `escape ${JSON.stringify(e.input)}`); }
  console.log(`${f}: ${vec.cases.length} cases checked`);
}

function checkRealCompile(f, vec) {
  total++;
  const req = Buffer.from(vec.request_utf8, 'utf8'), resp = Buffer.from(vec.response_utf8, 'utf8');
  const text = `${vec.model}:${sha(req)}:${sha(resp)}`;
  if (vec.signature.text !== text) return fail(f, 'signed text does not bind these exact request/response bytes');
  const who = recover(text, vec.signature.signature);
  if (!who || who.toLowerCase() !== String(vec.signature.signing_address).toLowerCase()) return fail(f, 'signature does not recover to signing_address');
  if (ATTESTED[vec.model] && who.toLowerCase() !== ATTESTED[vec.model]) return fail(f, `signer ${who} is not the attested signer for ${vec.model}`);
  const content = JSON.parse(vec.response_utf8).choices?.[0]?.message?.content ?? null;
  const verdict = content ? 'content OK' : 'no content (E_NO_CONTENT: the model spent its tokens reasoning)';
  console.log(`${f}: signature OK (provider_tee, attested signer ${who.slice(0, 10)}…), ${verdict}`);
}

function checkPortrait(f, vec) {
  total++;
  const sig = vec.signature?.body;
  if (!sig || typeof sig !== 'object') return fail(f, 'no signature recorded');
  const who = recover(sig.text, sig.signature);
  if (!who || who.toLowerCase() !== String(sig.signing_address).toLowerCase()) return fail(f, 'signature does not recover to signing_address');
  if (who.toLowerCase() !== ATTESTED['black-forest-labs/FLUX.2-klein-4B']) return fail(f, 'signer is not the attested FLUX signer');
  const bound = vec.response_sha256 ? `; response sha256 ${vec.response_sha256 === sig.text.split(':')[2] ? 'matches' : 'DOES NOT match'}` : '; image bytes not recorded, so the image-to-signature binding is not checkable from this file';
  if (vec.response_sha256 && vec.response_sha256 !== sig.text.split(':')[2]) return fail(f, 'response hash mismatch');
  console.log(`${f}: signature OK (provider_tee, attested FLUX signer)${bound}`);
}

let files = process.argv.slice(2);
if (!files.length) {
  const d = join(root, 'vectors');
  files = readdirSync(d).filter((n) => n.endsWith('.json') && !n.startsWith('attestation-') && n !== 'escape-cases.json').map((n) => join(d, n));
}
for (const path of files) {
  const f = path.split('/').pop();
  const vec = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(vec.cases)) checkCaseTable(f, vec);
  else if (typeof vec.request_utf8 === 'string' && vec.signature) checkRealCompile(f, vec);
  else if (f.startsWith('portrait-')) checkPortrait(f, vec);
  else console.log(`${f}: skipped (unknown schema)`);
}
console.log(bad ? `FAIL ${bad}/${total}` : `OK ${total}/${total} checks passed`);
process.exit(bad ? 1 : 0);
