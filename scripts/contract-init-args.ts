// JSON arguments for deploy-contract.sh (so the shell script never builds JSON by hand). Prints one JSON document to stdout.
//   pnpm --dir web exec tsx ../scripts/contract-init-args.ts new <staging|production>   -> args of the contract's `new`
//   pnpm --dir web exec tsx ../scripts/contract-init-args.ts belt <1|2|3>                -> args of create_belt
//   pnpm --dir web exec tsx ../scripts/contract-init-args.ts address                     -> the stand-in signer address
// staging: relayer mode, the stand-in address is the only AI signer, model 'standin/compiler-v1', allowlist timelock 0.
// production: outlayer mode, the AI signer(s) come from the live NEAR AI attestation report of NEARAI_MODEL (public, no key).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, envLocal } from './lib'
import { loadSimSync } from '../web/src/sim'
import { standinAddress } from '../web/functions/_lib/standinKey'

const STANDIN_MODEL = 'standin/compiler-v1'
const DEFAULT_MODEL = 'Qwen/Qwen3.8-27B'
const OWNER = 'titleshot.testnet'
const PROJECT = 'titleshot.testnet/titleshot-forge'
const PURSE_CHAIN = 84532 // Base Sepolia
const TOLL_YOCTO = '50000000000000000000000' // 0.05 NEAR
const BELTS = ['The Midnight Belt', 'The Tide Belt', 'The Wildcard Belt']

const die = (m: string): never => { console.error(m); process.exit(1) }
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

/** The contract's own minimum forge fee (contract/src/util.rs), so the script never drifts from the source. */
function minForgeFee(): string {
  const m = /MIN_FORGE_FEE: u128 = ([0-9_]+)/.exec(readFileSync(join(ROOT, 'contract/src/util.rs'), 'utf8'))
  return m ? m[1]!.replace(/_/g, '') : die('cannot read MIN_FORGE_FEE from contract/src/util.rs')
}

async function attestedSigners(model: string): Promise<string[]> {
  const base = process.env.NEARAI_BASE ?? 'https://cloud-api.near.ai'
  const r = await fetch(`${base}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`)
  if (!r.ok) die(`attestation report for ${model}: HTTP ${r.status} (this model is not TEE-attested, or NEAR AI is down)`)
  const j = (await r.json()) as { model_attestations?: { signing_address?: string }[]; gateway_attestation?: { signing_address?: string } }
  const list = (j.model_attestations ?? []).map((m) => m.signing_address ?? '').filter(Boolean)
  if (process.env.INCLUDE_GATEWAY === '1' && j.gateway_attestation?.signing_address) list.push(j.gateway_attestation.signing_address)
  const out = [...new Set(list.map((a) => (a.startsWith('0x') ? a : `0x${a}`).toLowerCase()))]
  if (!out.length) die(`attestation report for ${model} lists no signing address`)
  if (out.length > 8) die(`attestation report lists ${out.length} signers; the contract takes at most 8`)
  return out
}

async function newArgs(mode: string) {
  const sim = loadSimSync(readFileSync(join(ROOT, 'web/src/sim/pkg/bout_sim_bg.wasm')))
  const staging = mode === 'staging'
  if (!staging && mode !== 'production') die('mode must be staging or production')
  const key = envLocal('STANDIN_SIGNER_KEY')
  if (staging && !key) die('STANDIN_SIGNER_KEY is not in .env.local: run node scripts/gen-standin-key.mjs first')
  const model = staging ? STANDIN_MODEL : process.env.NEARAI_MODEL ?? DEFAULT_MODEL
  const parts = sim.requestParts(model) // the same prefix/suffix the Worker, the forge and the browser build
  const kind = process.env.SIGNATURE_KIND ?? 'provider_tee'
  if (kind !== 'provider_tee' && kind !== 'gateway') die('SIGNATURE_KIND must be provider_tee or gateway')
  const delay = Number(process.env.ALLOWLIST_DELAY_SEC ?? (staging ? 0 : 3600))
  if (!Number.isInteger(delay) || delay < 0) die('ALLOWLIST_DELAY_SEC must be a non-negative integer')
  return {
    owner: OWNER, outlayer: 'outlayer.testnet', forge_project: PROJECT, mpc_signer: 'v1.signer-prod.testnet',
    model_id: model, req_prefix: b64(parts.prefix), req_suffix: b64(parts.suffix), signature_kind: staging ? 'provider_tee' : kind,
    signer_allowlist: staging ? [standinAddress(key!)] : await attestedSigners(model),
    forge_mode: staging ? 'relayer' : 'outlayer', allowlist_delay_sec: delay,
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'new') console.log(JSON.stringify(await newArgs(arg ?? '')))
  else if (cmd === 'belt') {
    const name = BELTS[Number(arg) - 1] ?? die('belt index must be 1, 2 or 3')
    console.log(JSON.stringify({ name, promoter: 'vance.titleshot.testnet', toll: TOLL_YOCTO, forge_fee: minForgeFee(), purse_chain_id: PURSE_CHAIN }))
  } else if (cmd === 'address') {
    const key = envLocal('STANDIN_SIGNER_KEY') ?? die('STANDIN_SIGNER_KEY is not in .env.local')
    console.log(standinAddress(key))
  } else die('usage: contract-init-args.ts new <staging|production> | belt <1|2|3> | address')
}
main().catch((e) => die(String(e?.message ?? e)))
