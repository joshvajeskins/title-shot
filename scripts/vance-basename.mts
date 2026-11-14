// Registers Velvet Vance's Basename on Base Sepolia FROM its Chain Signatures address. vance.titleshot.testnet asks the MPC
// network (v1.signer-prod.testnet, path "vance-purse") to sign the register transaction: no person holds that key.
// The name gets an addr record (Vance's address), text records, and becomes the address's primary name, in one tx.
//   cd web && pnpm exec tsx ../scripts/vance-basename.mts [--dry-run] [--name velvetvance]
// Spend guard: Vance's test ETH funds season purses, so price + worst-case gas must stay under MAX_SPEND_WEI (0.003 ETH).
// Idempotent: if the address already has a primary name it prints it and stops. Secrets are never printed.
import { Rpc } from '../web/src/game/chain/rpc'
import { Signer, TGAS } from '../web/src/game/chain/signer'
import { BASENAMES, Basenames, VANCE_BASE_ADDRESS, registerCalldata } from '../web/src/game/chain/basenames'
import { BASESCAN, txUrl } from '../web/src/game/chain/config'
import { BASE_CHAIN_ID, deriveEvmAddress, getBalance, getFeeHistory, getNonce, getReceipt, sendRaw, txHashOf } from '../web/functions/_lib/evm'
import { feeParams } from '../web/functions/_lib/fees'
import { parseMpcSignature, recoverSigner, signedRaw, txDigest, VANCE_PATH, type Eip1559Tx } from '../web/functions/_lib/purse'
import { DEFAULTS } from '../web/functions/_lib/env'
import { loadCred } from './lib'

const MAX_SPEND_WEI = 3_000_000_000_000_000n // 0.003 ETH
const CANDIDATES = ['velvetvance', 'velvet-vance', 'velvetvancepromo', 'vance-promoter']
const SITE = 'https://preview.title-shot.pages.dev'
const TEXTS = {
  description: 'Velvet Vance, the AI fight promoter of TITLE SHOT. This address is a NEAR Chain Signatures key of vance.titleshot.testnet (path vance-purse): no person holds it.',
  url: SITE,
  avatar: `${SITE}/art/promoter-vance.webp`,
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined
const eth = (w: bigint) => `${(Number(w) / 1e18).toFixed(6)} ETH`
const fail = (msg: string): never => { console.error(`STOP: ${msg}`); process.exit(1) }

const near = new Rpc()
const base = new Rpc({ urls: DEFAULTS.baseRpcs })
const MPC = DEFAULTS.mpcSigner
const vanceId = DEFAULTS.vanceId
const bn = new Basenames(base, 0)

const from = (await deriveEvmAddress(near, MPC, VANCE_PATH, vanceId)).toLowerCase()
console.log(`Vance (${vanceId}) Base Sepolia address via ${MPC}, path ${VANCE_PATH}: ${from}`)
if (from !== VANCE_BASE_ADDRESS) fail(`derived address differs from VANCE_BASE_ADDRESS in basenames.ts (${VANCE_BASE_ADDRESS})`)

const existing = await bn.reverse(from)
if (existing) {
  console.log(`Already registered: ${from} is ${existing} (forward and reverse agree). Nothing to do.`)
  process.exit(0)
}

let label: string | null = null
for (const c of nameArg ? [nameArg] : CANDIDATES) {
  const fwd = await bn.lookup(c)
  if (fwd.status === 'ok' && fwd.address === from) fail(`${c}.basetest.eth already points at Vance but is not its primary name; set it with ReverseRegistrar.setName`)
  if (await bn.available(c)) { label = c; break }
  console.log(`  ${c}.basetest.eth is taken`)
}
if (!label) fail('no candidate name is available')
const name = `${label}.${BASENAMES.parent}`

const price = await bn.price(label!)
if (price === null) fail('could not read the registration price')
const value = price! + price! / 20n // 5% headroom; the controller refunds any excess to the sender
const data = registerCalldata(label!, from, TEXTS)
const estimate = await base.call<string>('eth_estimateGas', [{ from, to: BASENAMES.controller, value: `0x${value.toString(16)}`, data }])
  .then((g) => BigInt(g)).catch((e) => fail(`eth_estimateGas reverted: ${String(e).slice(0, 200)}`))
const gas = (estimate * 125n) / 100n
const fees = feeParams(await getFeeHistory(base))
const worst = value + gas * fees.maxFee
const balance = await getBalance(base, from)
console.log(`Name ${name}: price ${eth(price!)} for 1 year, sending ${eth(value)}, gas ${gas} at <= ${fees.maxFee} wei => worst case ${eth(worst)}`)
console.log(`Vance balance ${eth(balance)}; cap ${eth(MAX_SPEND_WEI)}`)
if (worst > MAX_SPEND_WEI) fail(`worst-case spend ${eth(worst)} is over the ${eth(MAX_SPEND_WEI)} cap`)
if (worst > balance) fail('Vance cannot afford it')
if (dryRun) { console.log('Dry run: nothing signed or sent.'); process.exit(0) }

const cred = loadCred(vanceId) ?? fail(`no credentials for ${vanceId} in ~/.near-credentials/testnet`)
const vance = new Signer(vanceId, cred.key, near)
const nonce = await getNonce(base, from)
const tx: Eip1559Tx & { data: `0x${string}` } = {
  type: 'eip1559', chainId: BASE_CHAIN_ID, nonce: Number(nonce), to: BASENAMES.controller, value, gas,
  maxFeePerGas: fees.maxFee, maxPriorityFeePerGas: fees.priority, data,
}
const digest = txDigest(tx)
console.log(`Asking the MPC network to sign digest ${digest} for ${vanceId}...`)
const t0 = Date.now()
const nearHash = await vance.send(MPC, [{
  kind: 'functionCall', method: 'sign', gas: 300n * TGAS, deposit: 1n,
  args: new TextEncoder().encode(JSON.stringify({ request: { payload_v2: { Ecdsa: digest.slice(2) }, path: VANCE_PATH, domain_id: 0 } })),
}])
const out = await vance.wait(nearHash, 180_000)
if (out.failure) fail(`MPC sign failed: ${out.failure.slice(0, 160)} (NEAR tx ${txUrl(nearHash)})`)
const raw = signedRaw(tx, parseMpcSignature(out.value))
const recovered = (await recoverSigner(raw)).toLowerCase()
console.log(`Signed in ${Date.now() - t0} ms; signature recovers to ${recovered}`)
if (recovered !== from) fail('signature does not recover to Vance’s address; not broadcasting')

const hash = txHashOf(raw)
console.log(`Broadcasting ${hash}...`)
await sendRaw(base, raw)
let status: string | null = null
for (let i = 0; i < 60 && !status; i++) {
  const r = await getReceipt(base, hash).catch(() => null)
  if (r) status = r.status === '0x1' ? 'success' : 'reverted'
  else await new Promise((res) => setTimeout(res, 2000))
}
console.log(`Receipt: ${status ?? 'not mined after 120 s'}`)

const check = new Basenames(base, 0)
const fwd = await check.resolve(name)
const rev = await check.reverse(from)
console.log(`Forward ${name} -> ${fwd}; reverse ${from} -> ${rev}`)
const record = { name, address: from, nearTx: txUrl(nearHash), baseTx: `${BASESCAN}/tx/${hash}`, status, forwardOk: fwd === from, reverseOk: rev === name, at: new Date().toISOString() }
console.log(JSON.stringify(record, null, 2))
if (status !== 'success' || fwd !== from || rev !== name) process.exit(1)
