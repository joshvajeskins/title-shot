// Registers a Basename for the x402 demo agent's wallet (the AI agent that buys title shots on Base), so purses it wins at
// the bell land on a name. Unlike vance-basename.mts this wallet is an ordinary test EOA: it signs with its own key,
// X402_AGENT_PRIVATE_KEY in the gitignored .env.local (never printed). One tx: addr record, text records, primary name.
//   cd web && pnpm exec tsx ../scripts/agent-basename.mts [--dry-run] [--name ringside-agent]
// Spend guard: price + worst-case gas must stay under MAX_SPEND_WEI (0.002 ETH). Idempotent: an existing primary name stops it.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Rpc } from '../web/src/game/chain/rpc'
import { BASENAMES, Basenames, registerCalldata } from '../web/src/game/chain/basenames'
import { BASESCAN } from '../web/src/game/chain/config'
import { BASE_CHAIN_ID, getBalance, getFeeHistory, getNonce, getReceipt, sendRaw, txHashOf } from '../web/functions/_lib/evm'
import { feeParams } from '../web/functions/_lib/fees'
import { DEFAULTS } from '../web/functions/_lib/env'

// scripts/ has no node_modules of its own: load viem from web/ (as x402-agent.mjs does)
const { privateKeyToAccount } = createRequire(new URL('../web/package.json', import.meta.url))('viem/accounts') as typeof import('viem/accounts')
const MAX_SPEND_WEI = 2_000_000_000_000_000n // 0.002 ETH
const CANDIDATES = ['ringside-agent', 'titleshot-agent', 'ringside-bot', 'title-shot-agent']
const SITE = 'https://title-shot.pages.dev'
const TEXTS = {
  description: 'An AI agent that buys TITLE SHOT title shots on Base over x402. Purses its fighters win are paid here by a NEAR contract through Chain Signatures.',
  url: SITE,
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined
const eth = (w: bigint) => `${(Number(w) / 1e18).toFixed(6)} ETH`
const fail = (msg: string): never => { console.error(`STOP: ${msg}`); process.exit(1) }

const envLine = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('X402_AGENT_PRIVATE_KEY='))
if (!envLine) fail('X402_AGENT_PRIVATE_KEY is not in .env.local')
let pk = envLine!.slice('X402_AGENT_PRIVATE_KEY='.length).trim().replace(/^"|"$/g, '')
if (!pk.startsWith('0x')) pk = `0x${pk}`
const account = privateKeyToAccount(pk as `0x${string}`)
const from = account.address.toLowerCase()
console.log(`Agent wallet: ${from}`)

const base = new Rpc({ urls: DEFAULTS.baseRpcs })
const bn = new Basenames(base, 0)
const existing = await bn.reverse(from)
if (existing) { console.log(`Already registered: ${from} is ${existing}. Nothing to do.`); process.exit(0) }

let label: string | null = null
for (const c of nameArg ? [nameArg] : CANDIDATES) {
  if (await bn.available(c)) { label = c; break }
  console.log(`  ${c}.basetest.eth is taken`)
}
if (!label) fail('no candidate name is available')
const name = `${label}.${BASENAMES.parent}`

const price = await bn.price(label!)
if (price === null) fail('could not read the registration price')
const value = price! + price! / 20n // 5% headroom; the controller refunds any excess
const data = registerCalldata(label!, from, TEXTS)
const estimate = await base.call<string>('eth_estimateGas', [{ from, to: BASENAMES.controller, value: `0x${value.toString(16)}`, data }])
  .then((g) => BigInt(g)).catch((e) => fail(`eth_estimateGas reverted: ${String(e).slice(0, 200)}`))
const gas = (estimate * 125n) / 100n
const fees = feeParams(await getFeeHistory(base))
const worst = value + gas * fees.maxFee
const balance = await getBalance(base, from)
console.log(`Name ${name}: price ${eth(price!)} for 1 year, sending ${eth(value)}, worst case ${eth(worst)}; balance ${eth(balance)}`)
if (worst > MAX_SPEND_WEI) fail(`worst-case spend ${eth(worst)} is over the ${eth(MAX_SPEND_WEI)} cap`)
if (worst > balance) fail('the agent wallet cannot afford it: send it a little test ETH first')
if (dryRun) { console.log('Dry run: nothing signed or sent.'); process.exit(0) }

const nonce = await getNonce(base, from)
const raw = await account.signTransaction({
  type: 'eip1559', chainId: BASE_CHAIN_ID, nonce: Number(nonce), to: BASENAMES.controller as `0x${string}`, value, gas,
  maxFeePerGas: fees.maxFee, maxPriorityFeePerGas: fees.priority, data,
})
const hash = txHashOf(raw)
await sendRaw(base, raw)
console.log(`Broadcast ${BASESCAN}/tx/${hash}`)
let status: string | null = null
for (let i = 0; i < 60 && !status; i++) {
  const r = await getReceipt(base, hash).catch(() => null)
  if (r) status = r.status === '0x1' ? 'success' : 'reverted'
  else await new Promise((res) => setTimeout(res, 2000))
}
const check = new Basenames(base, 0)
const fwd = await check.resolve(name)
const rev = await check.reverse(from)
console.log(JSON.stringify({ name, address: from, baseTx: `${BASESCAN}/tx/${hash}`, status, forwardOk: fwd === from, reverseOk: rev === name }, null, 2))
if (status !== 'success' || fwd !== from || rev !== name) process.exit(1)
