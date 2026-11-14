#!/usr/bin/env node
// An autonomous challenger from Base: reads a belt's quote, asks for the fight, gets `402 Payment Required`, pays test USDC
// on Base Sepolia over x402 v2 (EIP-3009 transferWithAuthorization, settled by the facilitator: the agent needs no ETH),
// and watches Velvet Vance book the bout on NEAR. docs/BOXOFFICE.md
//
//   node scripts/x402-agent.mjs --belt 1 --sentence "a pigeon with a law degree"            (pays, books, watches)
//   node scripts/x402-agent.mjs --belt 1 --sentence "..." --dry-run    (signs, asks the facilitator to /verify; pays nothing)
// Options: --url <site> (default https://title-shot.pages.dev), --preview (free AI preview of the fighter first),
//          --key-file <path> (file holding the key or a X402_AGENT_PRIVATE_KEY= line; default: env, then ../.env.local),
//          --max-usdc <n> (refuse offers above this, default 1), --no-watch.
// The private key is read, never printed.
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { createPublicClient, http, getAddress, toHex, parseAbi, formatUnits } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const { baseSepolia } = require('viem/chains')

export const NETWORK = 'eip155:84532'
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const NEAR_RPCS = ['https://near-testnet.drpc.org', 'https://test.rpc.fastnear.com']
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
}

export const b64json = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64')
export const unb64json = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'))

/** The offer we are willing to pay: exact USDC on Base Sepolia, at most `maxUnits`, to the payTo the quote named. */
export function pickRequirements(pr, { maxUnits, payTo }) {
  const req = (pr?.accepts ?? []).find((a) => a.scheme === 'exact' && a.network === NETWORK && a.asset?.toLowerCase() === USDC.toLowerCase())
  if (!req) throw new Error('no exact USDC on Base Sepolia offer in the 402')
  if (BigInt(req.amount) > BigInt(maxUnits)) throw new Error(`price ${formatUnits(BigInt(req.amount), 6)} USDC is above the agent's limit`)
  if (payTo && req.payTo.toLowerCase() !== payTo.toLowerCase()) throw new Error('the 402 pays a different address than the quote: refusing')
  return req
}

/** x402 v2 PaymentPayload for scheme exact (EVM): an EIP-3009 authorization signed over the asset's EIP-712 domain. */
export async function buildPayment(account, pr, req, { nowSec = Math.floor(Date.now() / 1000), nonce } = {}) {
  const authorization = {
    from: account.address, to: getAddress(req.payTo), value: String(req.amount), validAfter: '0',
    validBefore: String(nowSec + (req.maxTimeoutSeconds ?? 300)),
    nonce: nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  }
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? 'USDC', version: req.extra?.version ?? '2', chainId: 84532, verifyingContract: getAddress(req.asset) },
    types: AUTH_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  })
  return { x402Version: 2, resource: pr.resource, accepted: req, payload: { authorization, signature } }
}

export function readKey(keyFile) {
  const pick = (text) => (/^(?:X402_AGENT_PRIVATE_KEY=)?\s*(0x[0-9a-fA-F]{64})\s*$/m.exec(text) ?? /X402_AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/.exec(text))?.[1]
  if (keyFile) { const k = pick(readFileSync(keyFile, 'utf8')); if (!k) throw new Error(`no private key in ${keyFile}`); return k }
  if (process.env.X402_AGENT_PRIVATE_KEY) return process.env.X402_AGENT_PRIVATE_KEY.trim()
  const local = new URL('../.env.local', import.meta.url)
  const k = existsSync(local) ? pick(readFileSync(local, 'utf8')) : undefined
  if (!k) throw new Error('set X402_AGENT_PRIVATE_KEY or pass --key-file')
  return k
}

const args = (argv) => {
  const o = { url: 'https://title-shot.pages.dev', belt: 1, maxUsdc: '1', watch: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--preview') o.preview = true
    else if (a === '--no-watch') o.watch = false
    else if (a === '--url') o.url = argv[++i]
    else if (a === '--belt') o.belt = Number(argv[++i])
    else if (a === '--sentence') o.sentence = argv[++i]
    else if (a === '--key-file') o.keyFile = argv[++i]
    else if (a === '--max-usdc') o.maxUsdc = argv[++i]
    else throw new Error(`unknown option ${a}`)
  }
  if (!o.sentence) throw new Error('pass --sentence "<your fighter>"')
  o.url = o.url.replace(/\/+$/, '')
  return o
}

const say = (tag, msg) => console.log(`\x1b[36m[agent]\x1b[0m ${tag.padEnd(9)} ${msg}`)
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function nearView(contract, method, a) {
  for (const url of NEAR_RPCS) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') } }) }).catch(() => null)
    const j = await r?.json().catch(() => null)
    if (j?.result?.result) return JSON.parse(Buffer.from(j.result.result).toString() || 'null')
  }
  return null
}

async function main() {
  const o = args(process.argv.slice(2))
  const account = privateKeyToAccount(readKey(o.keyFile))
  const base = createPublicClient({ chain: baseSepolia, transport: http() })

  const q = await (await fetch(`${o.url}/api/boxoffice/quote?belt=${o.belt}`)).json()
  if (!q.belt) throw new Error(`quote failed: ${q.error ?? 'no belt'}`)
  const b = q.belt
  say('quote', `belt ${b.id} "${b.name}": champion ${b.champion ? `"${b.champion.sentence}"` : '(none yet)'}, toll ${b.toll.near} NEAR`)
  say('', `price ${q.price.usdc} USDC on Base Sepolia -> Velvet Vance ${q.payTo}`)
  if (!b.bookable) say('warning', `not bookable right now: ${b.reason?.message}`)

  if (o.preview) {
    const p = await (await post(`${o.url}/api/preview`, { sentence: o.sentence })).json()
    say('preview', p.spec ? `"${o.sentence}" -> ${p.spec.name ?? 'fighter'} (${p.spec.school ?? '?'})${p.canonical ? ', already forged' : ''}` : `no preview (${p.code ?? 'error'})`)
  }

  const ask = await post(`${o.url}/api/boxoffice/challenge`, { belt: o.belt, sentence: o.sentence })
  let pr
  if (ask.status === 402) pr = ask.headers.get('payment-required') ? unb64json(ask.headers.get('payment-required')) : await ask.json()
  else {
    const j = await ask.json().catch(() => ({}))
    if (!o.dryRun) throw new Error(`expected 402, got ${ask.status} ${j.code ?? ''}: ${j.error ?? ''}`)
    say('dry-run', `the box office answered ${ask.status} ${j.code ?? ''}; signing against the quote's offer instead`)
    pr = { x402Version: 2, resource: { url: q.resource, description: 'title shot', mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: q.network, asset: q.asset, amount: q.price.amount, payTo: q.payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }] }
  }
  const req = pickRequirements(pr, { maxUnits: BigInt(Math.round(Number(o.maxUsdc) * 1e6)), payTo: q.payTo })
  say(ask.status === 402 ? '402' : 'offer', `${ask.status === 402 ? 'Payment Required: ' : ''}${req.scheme} ${formatUnits(BigInt(req.amount), 6)} USDC on ${req.network} to ${short(req.payTo)}`)

  const bal = await base.readContract({ address: USDC, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [account.address] })
  say('wallet', `${account.address} holds ${formatUnits(bal, 6)} USDC`)
  if (bal < BigInt(req.amount)) throw new Error(`not enough USDC: get some at https://faucet.circle.com (Base Sepolia) for ${account.address}`)

  const sign = async () => {
    const p = await buildPayment(account, pr, req)
    say('signed', `EIP-3009 transferWithAuthorization, nonce ${short(p.payload.authorization.nonce)}, valid ${req.maxTimeoutSeconds}s`)
    return p
  }
  const payment = await sign()
  let header = b64json(payment)

  if (o.dryRun) {
    const v = await (await post(`${q.facilitator}/verify`, { x402Version: 2, paymentPayload: payment, paymentRequirements: req })).json()
    say('dry-run', `facilitator /verify -> isValid ${v.isValid}${v.invalidReason ? ` (${v.invalidReason})` : ''}. Nothing was sent to the box office; no USDC moved.`)
    return
  }

  let res, j
  let fresh = 1 // a settlement the facilitator refused took nothing: one retry with a newly signed authorization
  for (let attempt = 0; attempt < 8; attempt++) { // the same payment header is safe to resend: the box office books it once
    res = await post(`${o.url}/api/boxoffice/challenge`, { belt: o.belt, sentence: o.sentence }, { 'PAYMENT-SIGNATURE': header })
    j = await res.json().catch(() => ({}))
    if (res.status === 402 && j.code === 'PAYMENT_FAILED' && fresh-- > 0) {
      say('retry', `${j.error} Signing a fresh authorization.`)
      header = b64json(await sign())
      continue
    }
    if (res.status !== 503 || !/PENDING/.test(j.code ?? '')) break
    say('pending', `${j.code}: retrying with the same payment in 5 s`)
    await sleep(5000)
  }
  if (res.status !== 200) throw new Error(`booking failed: HTTP ${res.status} ${j.code}: ${j.error}`)
  const settled = res.headers.get('payment-response') ? unb64json(res.headers.get('payment-response')) : {}
  say('booked', `challenge #${j.challengeId} on NEAR for corner ${j.guest}${j.replayed ? ' (replayed)' : ''}`)
  say('', `Base payment  ${j.links.settle}${settled.transaction ? '' : ' (settlement tx unknown)'}`)
  if (j.links.challenge) say('', `NEAR challenge ${j.links.challenge}`)

  if (!o.watch) return
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < 5 * 60_000) {
    const c = await nearView(q.contract, 'get_challenge', { id: j.challengeId }).catch(() => null)
    if (c && c.status !== last) { last = c.status; say('ring', `challenge #${j.challengeId}: ${c.status}${c.code ? ` (${c.code})` : ''}`) }
    if (c && c.status !== 'Forging') {
      if (c.fight_id != null) {
        const f = await nearView(q.contract, 'get_fight', { id: c.fight_id })
        say('result', f ? `fight #${f.id}: ${f.winner_code === 1 ? 'THE CHALLENGER FROM BASE WINS THE BELT' : f.winner_code === 2 ? 'draw: the champion keeps the belt' : 'the champion defends'}` : `fight #${c.fight_id}`)
      }
      return
    }
    await sleep(3000)
  }
  say('ring', 'still forging after 5 minutes; check the site.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`\x1b[31m[agent] ${e instanceof Error ? e.message : String(e)}\x1b[0m`); process.exit(1) })
}
