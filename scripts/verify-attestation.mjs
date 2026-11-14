#!/usr/bin/env node
// Independently check NEAR AI Cloud's TEE attestation for the model the game contract uses and tie
// the attested signer to the contract's AI-signer allowlist. See docs/ATTESTATION.md.
//   node scripts/verify-attestation.mjs [--offline] [--report <full-report.json>] [--json out.json]
//        [--contract ring.titleshot.testnet] [--model z-ai/glm-5.3-flash]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPS, INSTALL_HINT, PCCS, loadDeps, parseTdxQuote, replayRtmr3, tcbInfo, checkJwt, nrasVerify, nearView,
  hex, strip0x, sha, isTruncated,
} from './verify-attestation-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const offline = args.includes('--offline');
const contract = opt('--contract', 'ring.titleshot.testnet');
const model = opt('--model', 'z-ai/glm-5.3-flash');
const slug = model.replace(/[^A-Za-z0-9.]+/g, '_');
const cachePath = join(DEPS, `report-${slug}.json`);
const BASE = process.env.NEARAI_BASE || 'https://cloud-api.near.ai';

const IDS = [
  ['a_tdx_quote', 'Intel TDX quote vs Intel root of trust'],
  ['b_report_data', 'report_data binds signer address + nonce'],
  ['c_key_address', 'signer address = keccak256(attested pubkey)'],
  ['d_nonce', 'nonce freshness (live request)'],
  ['e_nvidia_gpu', 'NVIDIA GPU evidence (NRAS) + nonce'],
  ['f_rtmr3_compose', 'event-log replay of RTMR3 + compose hash'],
  ['g_allowlist', 'attested signer is in contract allowlist'],
];
const per = Object.fromEntries(IDS.map(([id]) => [id, []])); // per-instance results, aggregated later
const rec = (id, i, result, detail) => per[id].push({ i, result, detail });
const unv = (id, i, why) => rec(id, i, 'UNVERIFIED', why);

// ---------------------------------------------------------------- obtain the report
let report, source, nonce = null, liveCalls = 0;
async function getLive() {
  nonce = hex(randomBytes(32));
  const url = `${BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
  const headers = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    liveCalls++;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    if (res.ok) return res.json();
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      const m = existsSync(join(root, '.env.local')) && readFileSync(join(root, '.env.local'), 'utf8').split('\n')
        .map((l) => l.match(/^\s*(?:export\s+)?NEARAI_API_KEY\s*=\s*(.*)$/)).find(Boolean);
      if (!m) throw new Error(`attestation endpoint answered ${res.status} and no NEARAI_API_KEY is available`);
      headers.authorization = `Bearer ${m[1].trim().replace(/^["']|["']$/g, '')}`;
      continue;
    }
    throw new Error(`attestation endpoint HTTP ${res.status}`);
  }
}
let fatal = null;
try {
  if (!offline) {
    report = await getLive(); source = `live ${BASE}`;
    mkdirSync(DEPS, { recursive: true }); writeFileSync(cachePath, JSON.stringify(report));
  } else {
    // A full report recorded on 14 Nov 2026 ships in vectors/, so --offline works from a fresh clone.
    const fullVector = join(root, 'vectors', `attestation-${slug}-full.json`);
    const p = opt('--report', existsSync(cachePath) ? cachePath : existsSync(fullVector) ? fullVector : null);
    if (p) { report = JSON.parse(readFileSync(p, 'utf8')); source = `cached full report ${p}`; }
    else {
      report = JSON.parse(readFileSync(join(root, 'vectors', `attestation-${slug}.json`), 'utf8')).summary;
      source = 'recorded vector (fields truncated)';
    }
  }
} catch (e) { fatal = `could not obtain attestation report: ${e.message}`; }

const deps = loadDeps();
const entries = report?.model_attestations ?? [];
if (!fatal && !entries.length) fatal = 'report contains no model_attestations';

// ---------------------------------------------------------------- per-instance checks
for (let i = 0; !fatal && i < entries.length; i++) {
  const m = entries[i];
  const addr = strip0x(m.signing_address).toLowerCase();
  const fullQuote = !isTruncated(m.intel_quote);
  let q = null, verified = null;

  // a. TDX quote
  if (!fullQuote) unv('a_tdx_quote', i, 'quote truncated in recorded vector; run live once to cache a full report');
  else if (!deps.dcap) unv('a_tdx_quote', i, `dcap-qvl-node not installed; ${INSTALL_HINT}`);
  else {
    try {
      const raw = Buffer.from(m.intel_quote, 'hex');
      q = parseTdxQuote(raw);
      const coll = await deps.dcap.js_get_collateral(PCCS, raw);
      verified = deps.dcap.js_verify(raw, coll, BigInt(Math.floor(Date.now() / 1000)));
      const st = verified.status;
      const bad = /revoked/i.test(st);
      rec('a_tdx_quote', i, bad ? 'FAIL' : 'PASS', `TCB ${st}${verified.advisory_ids?.length ? ' advisories ' + verified.advisory_ids.join(',') : ''}; dcap-qvl-node ${deps.dcapVersion}, Intel PCS collateral`);
    } catch (e) { rec('a_tdx_quote', i, 'FAIL', `quote did not verify: ${e.message ?? e}`); }
  }

  // b. report_data = address (left-aligned, zero padded to 32) || nonce (32)
  const reqNonce = m.request_nonce;
  if (!q) unv('b_report_data', i, 'needs the verified quote (step a)');
  else {
    const rd = Buffer.from(q.reportData);
    const vrd = verified?.report?.TD10?.report_data;
    const cross = vrd ? (vrd.replace(/^0x/, '').toLowerCase() === hex(rd) ? 'matches dcap-parsed value' : 'MISMATCH with dcap-parsed value') : 'dcap value n/a';
    const wantAddr = Buffer.concat([Buffer.from(addr, 'hex'), Buffer.alloc(12)]);
    const okAddr = rd.subarray(0, 32).equals(wantAddr), okNonce = hex(rd.subarray(32)) === String(reqNonce).toLowerCase();
    const ok = okAddr && okNonce && !cross.startsWith('MISMATCH');
    rec('b_report_data', i, ok ? 'PASS' : 'FAIL', `addr ${okAddr ? 'ok' : 'WRONG'}, nonce ${okNonce ? 'ok' : 'WRONG'} (layout: report_data[0..32]=address padded, [32..64]=nonce; ${cross})`);
  }

  // c. address derives from attested public key
  if (isTruncated(m.signing_public_key)) unv('c_key_address', i, 'public key truncated in recorded vector');
  else if (!deps.sha3) unv('c_key_address', i, `@noble/hashes not installed; ${INSTALL_HINT}`);
  else {
    const pk = Buffer.from(strip0x(m.signing_public_key), 'hex');
    const xy = pk.length === 65 && pk[0] === 4 ? pk.subarray(1) : pk;
    const derived = hex(deps.sha3.keccak_256(xy).subarray(12));
    rec('c_key_address', i, xy.length === 64 && derived === addr ? 'PASS' : 'FAIL', `keccak256(pubkey)[12:] = 0x${derived}${derived === addr ? '' : ' != 0x' + addr}`);
  }
  // key-to-quote binding is carried by b (address in report_data); c ties it to the key.

  // d. freshness
  if (offline) unv('d_nonce', i, `offline: the nonce in the report is a recorded one, so freshness cannot be shown`);
  else rec('d_nonce', i, String(reqNonce).toLowerCase() === nonce ? 'PASS' : 'FAIL', `report echoes our random nonce ${nonce.slice(0, 12)}...: ${String(reqNonce).toLowerCase() === nonce}`);

  // e. NVIDIA GPU evidence
  if (isTruncated(m.nvidia_payload)) unv('e_nvidia_gpu', i, 'GPU payload truncated in recorded vector');
  else {
    try {
      const pl = JSON.parse(m.nvidia_payload);
      const nonceOk = String(pl.nonce).toLowerCase() === String(reqNonce).toLowerCase();
      const body = await nrasVerify(m.nvidia_payload);
      const overall = body[0]?.[1] ? await checkJwt(body[0][1]) : null;
      const verdict = overall?.payload['x-nvidia-overall-att-result'];
      const eat = overall?.payload['eat_nonce'];
      const nrasNonce = eat ? String(eat).toLowerCase() === String(pl.nonce).toLowerCase() : null;
      const ok = verdict === true && nonceOk && nrasNonce !== false && overall.sig !== 'INVALID';
      rec('e_nvidia_gpu', i, ok ? 'PASS' : 'FAIL', `NRAS overall=${verdict}; payload nonce == report nonce: ${nonceOk}; NRAS eat_nonce match: ${nrasNonce}; JWT signature ${overall?.sig}`);
    } catch (e) { unv('e_nvidia_gpu', i, `NRAS call failed: ${e.message}`); }
  }

  // f. event-log replay of RTMR3 + compose hash
  if (!q) unv('f_rtmr3_compose', i, 'needs the verified quote (step a)');
  else {
    try {
      const rp = replayRtmr3(m.event_log), tcb = tcbInfo(m.info);
      const rtmrOk = rp.rtmr3 === q.rtmr3;
      const ev = m.event_log.find((e) => e.event === 'compose-hash');
      const composeHash = tcb?.app_compose ? hex(sha('sha256', tcb.app_compose)) : null;
      const evOk = !!ev && ev.event_payload.toLowerCase() === composeHash && composeHash === m.info?.compose_hash?.toLowerCase();
      const ok = rtmrOk && evOk;
      rec('f_rtmr3_compose', i, ok ? 'PASS' : 'FAIL', `RTMR3 replay of ${rp.count} events ${rtmrOk ? '==' : '!='} quote RTMR3; sha256(app_compose) ${evOk ? '==' : '!='} compose-hash event & info.compose_hash (${composeHash?.slice(0, 12)}...); ${rp.recomputed} runtime-event digests recomputed from name+payload`);
    } catch (e) { unv('f_rtmr3_compose', i, `event log not usable: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- g. allowlist
let allow = null;
if (!fatal) {
  try {
    allow = await nearView(contract, 'get_allowlist');
    const active = (allow.active ?? []).map((a) => strip0x(a).toLowerCase());
    const attested = [...new Set(entries.map((m) => strip0x(m.signing_address).toLowerCase()))];
    const stepOk = (a) => per.a_tdx_quote.some((r) => r.result === 'PASS' && strip0x(entries[r.i].signing_address).toLowerCase() === a);
    const pend = allow.pending ? `PENDING change ${JSON.stringify(allow.pending)} activates_at ${allow.activates_at}` : 'no pending change';
    const inList = attested.filter((a) => active.includes(a));
    const orphans = active.filter((a) => !attested.includes(a));
    const quoted = inList.filter(stepOk);
    const detail = `${contract} active=[${active.map((a) => '0x' + a.slice(0, 8) + '..').join(',')}]; attested signers ${attested.length} (${inList.length} in allowlist, ${quoted.length} with verified quote); ${pend}`;
    if (!inList.length || orphans.length) rec('g_allowlist', 0, 'FAIL', detail + (orphans.length ? `; allowlist entries without attestation: ${orphans.join(',')}` : '; no attested signer in allowlist'));
    else if (!quoted.length) unv('g_allowlist', 0, detail + '; address matches but no attested quote was verified (step a), so the match is not yet an attestation result');
    else rec('g_allowlist', 0, 'PASS', detail);
  } catch (e) { unv('g_allowlist', 0, `contract view failed: ${e.message}`); }
}

// ---------------------------------------------------------------- aggregate + print
const steps = IDS.map(([id, title]) => {
  const r = fatal ? [{ i: 0, result: 'UNVERIFIED', detail: fatal }] : per[id].length ? per[id] : [{ i: 0, result: 'UNVERIFIED', detail: 'step did not run' }];
  const result = r.some((x) => x.result === 'FAIL') ? 'FAIL' : r.some((x) => x.result === 'UNVERIFIED') ? 'UNVERIFIED' : 'PASS';
  const uniq = [...new Set(r.map((x) => x.detail.replace(/\d+\.\.\./g, '')))];
  const detail = r.length === 1 ? r[0].detail : uniq.length === 1 ? `${r.length}/${r.length} instances: ${r[0].detail}` : r.map((x) => `[${x.i}] ${x.result}: ${x.detail}`).join(' | ');
  return { id, title, result, detail };
});
const overall = steps.some((s) => s.result === 'FAIL') ? 'FAIL' : steps.every((s) => s.result === 'PASS') ? 'PASS' : `INCOMPLETE (UNVERIFIED: ${steps.filter((s) => s.result !== 'PASS').map((s) => s.id).join(', ')})`;
const out = { model, mode: offline ? 'offline' : 'live', source, contract, instances: entries.length, neari_ai_calls: liveCalls, steps: steps.map(({ id, result, detail }) => ({ id, result, detail })), overall };

const w = Math.max(...IDS.map(([, t]) => t.length));
console.log(`model ${model} | ${out.mode} | source: ${source ?? 'n/a'} | contract ${contract} | ${entries.length} instance(s)\n`);
for (const s of steps) console.log(`${s.id.padEnd(16)} ${s.result.padEnd(11)} ${s.title.padEnd(w)}  ${s.detail}`);
console.log(`\nOVERALL: ${overall}\n`);
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(steps.some((s) => s.result === 'FAIL') ? 1 : 0);
