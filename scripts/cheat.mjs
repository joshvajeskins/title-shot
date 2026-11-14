// The contract refuses cheats, live (docs/CHEAT-RESULTS.md). Needs relayer forge mode and an open season.
// One test challenger opens real challenges; relay.titleshot.testnet (a listed relayer) then delivers forged results:
//   a  a genuine NEAR AI signed response with one byte of the fighter JSON changed
//   b  a genuine NEAR AI signed response for a different sentence than the challenge's
//   c  a well-formed response signed by a random, non-allowlisted secp256k1 key
//   d  a genuine result delivered twice (first delivery resolves a real bout, the replay is refused)
// Genuine responses are the recorded vectors in vectors/nearai-real-*-low.json: no NEAR AI call is made.
// Run from the repo root:  web/node_modules/.bin/tsx scripts/cheat.mjs        (preflight only, moves nothing)
//                          web/node_modules/.bin/tsx scripts/cheat.mjs --go   (live: creates the challenger with 0.3 NEAR)
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Rpc, contractCode } from '../web/src/game/chain/rpc.ts'
import { Signer, TGAS, NEAR } from '../web/src/game/chain/signer.ts'
import { eip191Digest, recoverAddress, sha256Hex } from '../web/src/game/chain/signature.ts'
import { toHex, utf8 } from '../web/src/game/chain/bytes.ts'
import { loadCred, ROOT, ROOT_ACCOUNT } from './lib.ts'

const { secp256k1 } = await import(new URL('../web/node_modules/@noble/curves/secp256k1.js', import.meta.url).href)
const GO = process.argv.includes('--go')
const CONTRACT = process.env.CHEAT_CONTRACT ?? 'ring.titleshot.testnet'
const CHALLENGER = process.env.CHEAT_ACCOUNT ?? 'cheat.titleshot.testnet'
const RELAYER = 'relay.titleshot.testnet'
const CREATE_NEAR = '0.3' // NEAR from titleshot.testnet to create the challenger (cap 0.5)
const DEPOSIT = 2n * NEAR / 10n // 0.2 NEAR of game balance (the first 0.005 is the contract's account storage)
const rpc = new Rpc({ urls: (process.env.CHEAT_RPC ?? 'http://127.0.0.1:8911/,https://near-testnet.drpc.org,https://test.rpc.fastnear.com').split(',') })
const view = (m, a = {}) => rpc.view(CONTRACT, m, a)
const near = (y) => (Number(BigInt(y)) / 1e24).toFixed(4)
const link = (h) => `[${h.slice(0, 8)}…](https://testnet.nearblocks.io/txns/${h})`
const say = (...a) => console.log(...a)
const stop = (msg, code = 2) => { say(msg); process.exit(code) }

// ---- recorded vectors: the request is prefix ‖ json_escape(sentence) ‖ suffix (what the contract rebuilds) ----
const vec = (n) => JSON.parse(readFileSync(join(ROOT, 'vectors', `nearai-real-z_ai_glm_5_3_flash-${n}-low.json`), 'utf8'))
const CACTUS = vec('cactus'), PIGEON = vec('pigeon')
const esc = (s) => JSON.stringify(s).slice(1, -1)
const at = CACTUS.request_utf8.lastIndexOf(esc(CACTUS.sentence))
const PREFIX = CACTUS.request_utf8.slice(0, at), SUFFIX = CACTUS.request_utf8.slice(at + esc(CACTUS.sentence).length)
const output = (v, response = v.response_utf8, sig = v.signature) => JSON.stringify({
  ok: true, response, signature: sig.signature, signing_address: sig.signing_address, signing_algo: 'ecdsa', signature_kind: v.signature_kind, text: sig.text,
})

/** (a) one byte of the fighter JSON: the cactus's power weight 6 -> 9. The signature is untouched. */
function tampered() {
  const needle = '\\"power\\":6'
  const i = CACTUS.response_utf8.indexOf(needle)
  if (i < 0) throw new Error('vector changed: power weight not found')
  const pos = i + needle.length - 1
  const resp = CACTUS.response_utf8.slice(0, pos) + '9' + CACTUS.response_utf8.slice(pos + 1)
  return { json: output(CACTUS, resp), note: `byte ${pos} of the signed response: \`"power":6\` → \`"power":9\`` }
}

/** (c) the right message format for this challenge's own sentence, signed by a fresh key no allowlist knows. */
function forgedSignature(sentence, model) {
  const content = JSON.parse(JSON.parse(CACTUS.response_utf8).choices[0].message.content)
  content.weights = { power: 10, guard: 10, speed: 10, grit: 10 }
  content.name = 'Perfect Ten'
  const env = JSON.parse(CACTUS.response_utf8)
  env.id = toHex(secp256k1.utils.randomSecretKey()).slice(0, 32)
  env.choices[0].message.content = JSON.stringify(content)
  const response = JSON.stringify(env)
  const text = `${model}:${sha256Hex(utf8(PREFIX + esc(sentence) + SUFFIX))}:${sha256Hex(utf8(response))}`
  const key = secp256k1.utils.randomSecretKey()
  const rec = secp256k1.sign(eip191Digest(text), key, { prehash: false, format: 'recovered' }) // recovery byte first
  const sig = '0x' + toHex(rec.slice(1)) + (27 + rec[0]).toString(16)
  const addr = recoverAddress(text, sig)
  return { json: output(CACTUS, response, { text, signature: sig, signing_address: addr }), note: `signer ${addr.slice(0, 10)}… (random key), all weights 10` }
}

// ---- preflight: relayer mode, an open season, caps, keys ----
const cfg = await view('get_config')
if (cfg.forge_mode !== 'relayer') {
  const when = cfg.pending_config?.activates_at ? new Date(Number(BigInt(cfg.pending_config.activates_at) / 1_000_000n)).toString() : 'not staged'
  stop(`relayer forge mode is not active on ${CONTRACT} (forge_mode=${cfg.forge_mode}; staged switch: ${when}). Nothing done.`)
}
if (!cfg.relayers.includes(RELAYER)) stop(`${RELAYER} is not a listed relayer`)
if (sha256Hex(utf8(PREFIX)) !== cfg.prefix_sha256 || sha256Hex(utf8(SUFFIX)) !== cfg.suffix_sha256) stop('the recorded vectors do not match the contract request parts')
const allow = await view('get_allowlist')
if (!allow.active.includes(CACTUS.recovered)) stop(`vector signer ${CACTUS.recovered} is not allowlisted: genuine cases would not be genuine`)
const nowNs = BigInt(Date.now()) * 1_000_000n
const belts = (await view('get_belts')).filter((b) => b.season?.state === 'Open' && b.champion && BigInt(b.season.closes_at) > nowNs + 15n * 60_000_000_000n && b.holder !== CHALLENGER)
if (!belts.length) stop('no belt has an open season with a champion (and 15 min left) yet: run again once Vance has opened one.', 3)
const belt = belts[0]
const caps = await view('get_compile_caps')
if (!caps.open || caps.daily - caps.today < 5 || caps.total - caps.used < 5) stop(`compile cap too close (${JSON.stringify(caps)})`)
const relayCred = loadCred(RELAYER)
if (!relayCred) stop(`no key for ${RELAYER} in ~/.near-credentials/testnet`)
const toll = BigInt(belt.toll)
say(`contract ${CONTRACT} (relayer mode), belt ${belt.id} "${belt.name}" season ${belt.season.id}, toll ${near(toll)} NEAR, fee ${near(belt.forge_fee)} NEAR`)

// fresh sentences: a cached fighter would skip the compile (and with it the signature check), so each case needs a new one
const fresh = async (list) => { for (const s of list) if (!(await view('get_fighter_by_sentence', { sentence: s }))) return s; return null }
const plan = {
  a: CACTUS.sentence,
  b: await fresh(['a sumo wrestler made entirely of bubble wrap', 'a disco ball that refuses to stop spinning', 'a lighthouse that only blinks in morse insults']),
  c: await fresh(['a fighter with perfect stats and a fake referee', 'a counterfeit champion with a cardboard belt', 'a tax auditor who forged his own black belt']),
  d: PIGEON.sentence,
}
for (const [k, s] of Object.entries(plan)) {
  if (!s) stop(`no fresh sentence left for case ${k}`)
  if (k === 'a' && (await view('get_fighter_by_sentence', { sentence: s }))) stop(`case a: "${s}" is already forged on chain, so no compile would be checked`)
}
say('plan:', JSON.stringify(plan))
if (!GO) stop('preflight ok. Add --go to run it live.', 0)

// ---- the test challenger (near-cli creates it and saves its key in ~/.near-credentials) ----
let cred = loadCred(CHALLENGER)
if (!cred) {
  const exists = await rpc.balance(CHALLENGER).then(() => true, () => false)
  if (exists) stop(`${CHALLENGER} exists but its key is not in ~/.near-credentials/testnet`)
  const r = spawnSync(join(process.env.HOME, '.cargo/bin/near'), ['account', 'create-account', 'fund-myself', CHALLENGER, `${CREATE_NEAR} NEAR`, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'sign-as', ROOT_ACCOUNT, 'network-config', 'testnet-drpc', 'sign-with-legacy-keychain', 'send'], { encoding: 'utf8' })
  const tx = /Transaction ID: *([A-Za-z0-9]{40,50})/.exec((r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, ''))?.[1]
  if (r.status !== 0) stop(`could not create ${CHALLENGER}`, 1)
  say(`created ${CHALLENGER} with ${CREATE_NEAR} NEAR from ${ROOT_ACCOUNT}, tx ${tx ?? '?'}`)
  for (let i = 0; i < 10 && !(cred = loadCred(CHALLENGER)); i++) await new Promise((r) => setTimeout(r, 500))
  if (!cred) stop('key file not found after creation', 1)
}
const me = new Signer(CHALLENGER, cred.key, rpc)
for (let i = 0; ; i++) { // a just-created account's key may take a few seconds to reach every RPC node
  try { await rpc.accessKeyNonce(CHALLENGER, me.publicKey); break } catch (e) { if (i >= 15) throw e; await new Promise((r) => setTimeout(r, 2000)) }
}
const relay = new Signer(RELAYER, relayCred.key, rpc)
const balance = async () => BigInt(await view('balance_of', { account: CHALLENGER }))
const pending = await view('get_pending', { account: CHALLENGER })
if (pending) stop(`${CHALLENGER} still has challenge #${pending.id} pending (${pending.status}); it expires 10 min after creation.`)
const moves = []
if ((await balance()) < 2n * toll) { // one toll is in flight at a time; a refusal returns most of it
  const d = await me.call(CONTRACT, 'deposit', {}, 30n * TGAS, DEPOSIT)
  if (d.failure) stop(`deposit failed: ${contractCode(d.failure) ?? d.failure}`, 1)
  moves.push(`deposit ${near(DEPOSIT)} NEAR ${link(d.hash)}`)
} else {
  moves.push(`challenger game balance at start ${near(await balance())} NEAR (from an earlier deposit)`)
}

// A send that never lands (a dropped broadcast, an RPC timeout) is retried once with a new transaction. Safe: a second
// challenge would hit E_PENDING and a second delivery E_NOT_FORGING, so nothing can happen twice.
// Gas: testnet prepays at 1 Ggas-price (10x the current price): 300 Tgas needs 0.301 NEAR on the signer or the tx is dropped as
// NotEnoughBalance. challenge() in relayer mode makes no cross-contract call; submit_forge verifies + fights well under 200.
const GAS = { challenge: 50n * TGAS, submit_forge: 200n * TGAS }
async function call(signer, method, args) {
  for (let i = 0; ; i++) {
    try { return await signer.call(CONTRACT, method, args, GAS[method], 0n, 60_000) } catch (e) {
      if (i >= 1 || !/timeout/i.test(String(e))) throw e
      say(`  ${method}: ${String(e).slice(0, 90)}; sending again`)
    }
  }
}

// ---- one case: challenge, then the relayer delivers the forged output at once ----
const rows = []
async function attempt(k, label, sentence, outputFor, extra = '') {
  const before = await balance()
  const ch = await call(me, 'challenge', { belt_id: belt.id, sentence })
  if (ch.failure) { rows.push({ k, label, tx: ch.hash, code: contractCode(ch.failure) ?? 'challenge failed', refund: 'toll not taken', note: 'refused at challenge()' }); return null }
  const id = Number(ch.value)
  const { json, note } = typeof outputFor === 'function' ? outputFor(sentence) : outputFor
  const sub = await call(relay, 'submit_forge', { challenge_id: id, output_json: json })
  const c = await view('get_challenge', { id })
  const after = await balance()
  const data = (name) => { const e = sub.events.find((x) => x.event === name); return e ? (Array.isArray(e.data) ? e.data[0] : e.data) : null }
  const ev = data('rejected') ?? data('refunded')
  const bout = data('bout')
  const status = c?.status ?? '?'
  const code = sub.failure ? contractCode(sub.failure) ?? 'tx failed'
    : ev ? `${ev.code}${ev.detail ? ` (${ev.detail})` : ''}`
    : bout ? `accepted: ${status}, bout #${bout.fight_id}, winner ${bout.winner}` : `${status} ${c?.code ?? ''}`.trim()
  let refund = '—'
  if (bout) refund = `none: toll ${near(toll)} NEAR paid into the bout split`
  if (ev) {
    const ok = after === before - toll + BigInt(ev.amount)
    refund = `${near(ev.amount)} NEAR back = toll ${near(toll)} − fee ${near(belt.forge_fee)} − storage ${near(ev.storage)} (${ev.storage_bytes} B)${ok ? ' ✓' : ' ✗ balance mismatch'}`
  }
  rows.push({ k, label, id, sentence, challengeTx: ch.hash, tx: sub.hash, code, refund, note: note + extra, json, failed: !!sub.failure, status, before, after })
  return rows[rows.length - 1]
}

await attempt('a', 'genuine signed response, one byte of the fighter JSON changed', plan.a, tampered())
await attempt('b', `genuine signed response for another sentence ("${CACTUS.sentence}")`, plan.b, { json: output(CACTUS), note: 'untouched NEAR AI response + signature' })
await attempt('c', 'right message format, signed by a random non-allowlisted key', plan.c, (s) => forgedSignature(s, cfg.model_id))
// d: the genuine pigeon compile resolves a real bout first (proof the verifier accepts the real thing), then the same delivery again
const first = await attempt('d0', 'control: the genuine signed result, delivered once', plan.d, { json: output(PIGEON), note: 'untouched NEAR AI response + signature' })
if (first) {
  const before = await balance()
  const again = await call(relay, 'submit_forge', { challenge_id: first.id, output_json: first.json })
  const after = await balance()
  const st = await view('get_challenge', { id: first.id })
  rows.push({ k: 'd', label: `replay: the same result delivered again for challenge #${first.id}`, tx: again.hash, code: again.failure ? contractCode(again.failure) ?? 'tx failed' : `accepted?! ${JSON.stringify(again.value)}`,
    refund: after === before ? `none: balance unchanged (${near(after)} NEAR), challenge stays ${st?.status}` : `✗ balance moved ${near(after - before)}`, note: '' })
}

// ---- report ----
const table = ['| case | what the relayer delivered | tx (submit_forge) | contract code | refund |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.k} | ${r.label}${r.id !== undefined ? ` — challenge #${r.id}` : ''}${r.note ? `; ${r.note}` : ''} | ${link(r.tx)} | \`${r.code}\` | ${r.refund} |`)].join('\n')
const doc = `# The contract refuses cheats (live, testnet)

Run ${new Date().toISOString()} by \`scripts/cheat.mjs --go\` against \`${CONTRACT}\` in relayer forge mode. Test challenger \`${CHALLENGER}\`
challenged belt ${belt.id} "${belt.name}" (season ${belt.season.id}, toll ${near(toll)} NEAR, forge fee ${near(belt.forge_fee)} NEAR); the listed relayer
\`${RELAYER}\` delivered each forged result with \`submit_forge\`. The contract rebuilds the NEAR AI request from the challenge's own
sentence, hashes the delivered response, recovers the EIP-191 signer with \`ecrecover\` and checks the timelocked allowlist
(\`${allow.active.join(', ')}\`). Genuine responses are recorded real NEAR AI vectors (\`vectors/nearai-real-*-low.json\`).

${table}

\`E_AI_SIG\` is the challenge's terminal status (\`get_challenge\` → \`Rejected\`), with the verifier's own code in brackets
(\`E_SIGNER\`: the recovered address is not on the allowlist). A refusal refunds the toll minus the forge fee and the storage the
refused challenge leaves behind (docs/CONTRACT.md). \`E_NOT_FORGING\` is a panic of \`submit_forge\`: a settled challenge cannot be
settled again, so no second bout, payout or refund happens.
${moves.length ? `\nSetup: ${moves.join('; ')}.\n` : ''}`
writeFileSync(join(ROOT, 'docs', 'CHEAT-RESULTS.md'), doc)
say(table)
say(`\nchallenger balance now ${near(await balance())} NEAR; saved docs/CHEAT-RESULTS.md`)
process.exit(rows.some((r) => r.k !== 'd0' && !/^E_/.test(r.code)) ? 1 : 0)
