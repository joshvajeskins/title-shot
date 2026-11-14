// Helpers for scripts/verify-attestation.mjs: TDX quote parsing, RTMR3 replay,
// NVIDIA NRAS verdict + JWT check, NEAR view calls. No secrets are handled here.
import { createHash, createPublicKey, verify as cverify } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEPS = process.env.ATTEST_DEPS || join(homedir(), '.cache', 'titleshot-attest');
export const INSTALL_HINT = `mkdir -p ${DEPS} && cd ${DEPS} && npm init -y >/dev/null && npm i @phala/dcap-qvl-node@0.3.3 @noble/hashes@1.8.0`;
export const NRAS = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
export const PCCS = 'https://api.trustedservices.intel.com/tdx/certification/v4';
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org'];

export const hex = (b) => Buffer.from(b).toString('hex');
export const strip0x = (s) => String(s).replace(/^0x/i, '');
export const sha = (alg, ...parts) => { const h = createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
export const isTruncated = (s) => typeof s !== 'string' || /\.\.\.\(\d+ chars\)/.test(s);

export function loadDeps() {
  const out = {};
  const req = createRequire(join(DEPS, 'x.js'));
  try { out.dcap = req('@phala/dcap-qvl-node'); } catch { out.dcap = null; }
  try { out.sha3 = req('@noble/hashes/sha3'); } catch { out.sha3 = null; }
  out.dcapVersion = out.dcap ? JSON.parse(req('fs').readFileSync(req.resolve('@phala/dcap-qvl-node/package.json'), 'utf8')).version : null;
  return out;
}

/** TDX quote v4/v5-TD10 body: header 48 bytes, then TD report body (584 bytes). */
export function parseTdxQuote(q) {
  const version = q.readUInt16LE(0), teeType = q.readUInt32LE(4);
  if (version !== 4 || teeType !== 0x81) throw new Error(`not a TDX v4 quote (version ${version}, tee_type 0x${teeType.toString(16)})`);
  const b = 48, f = (o, n) => hex(q.subarray(b + o, b + o + n));
  return { version, mrtd: f(136, 48), rtmr0: f(328, 48), rtmr1: f(376, 48), rtmr2: f(424, 48), rtmr3: f(472, 48), reportData: q.subarray(b + 520, b + 584) };
}

/** Replay RTMR3 from the dstack event log (imr 3): rtmr = SHA384(rtmr || digest padded to 48). */
export function replayRtmr3(events) {
  let r = Buffer.alloc(48);
  let n = 0, recomputed = 0, mismatched = 0;
  for (const e of events) {
    if (e.imr !== 3) continue;
    // dstack runtime events: digest = sha384(u32le(type) ':' name ':' payload). The log may omit it; recompute.
    const t = Buffer.alloc(4); t.writeUInt32LE(e.event_type >>> 0);
    const own = sha('sha384', t, ':', e.event || '', ':', Buffer.from(e.event_payload || '', 'hex'));
    let d = own;
    if (e.digest) { d = Buffer.from(e.digest, 'hex'); if (!own.equals(d)) mismatched++; } else recomputed++;
    r = sha('sha384', r, Buffer.concat([d, Buffer.alloc(Math.max(0, 48 - d.length))]));
    n++;
  }
  return { rtmr3: hex(r), count: n, recomputed, mismatched };
}

export const tcbInfo = (info) => {
  const t = info?.tcb_info;
  return typeof t === 'string' ? JSON.parse(t) : t || null;
};

function b64u(s) { return Buffer.from(s, 'base64url'); }

/** Decode a JWT and (best effort) verify its ES384/ES256 signature against NVIDIA's JWKS. */
export async function checkJwt(token) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(b64u(h).toString()), payload = JSON.parse(b64u(p).toString());
  let sig = 'unchecked';
  try {
    const iss = payload.iss || 'https://nras.attestation.nvidia.com';
    const jwks = await (await fetch(new URL('/.well-known/jwks.json', iss), { signal: AbortSignal.timeout(20000) })).json();
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error(`kid ${header.kid} not in JWKS`);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const hash = header.alg === 'ES256' ? 'sha256' : 'sha384';
    sig = cverify(hash, Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64u(s)) ? 'valid' : 'INVALID';
  } catch (e) { sig = `unchecked (${e.message})`; }
  return { header, payload, sig };
}

export async function nrasVerify(payloadStr) {
  const res = await fetch(NRAS, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: payloadStr, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`NRAS HTTP ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

/** NEAR testnet view call via JSON-RPC, with fallback node. */
export async function nearView(contract, method) {
  let last;
  for (const rpc of RPCS) {
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: 'e30=' } }),
      });
      const j = await res.json();
      if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 160));
      return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
    } catch (e) { last = `${rpc}: ${e.message}`; }
  }
  throw new Error(last);
}

export const depsPresent = () => existsSync(join(DEPS, 'node_modules'));
