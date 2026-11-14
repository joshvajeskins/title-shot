#!/usr/bin/env node
// Store NEARAI_API_KEY from .env.local as the OutLayer project secret, opened only for calls that arrive
// through the given game contract. Never prints the key; passes it to the CLI as one argv element.
//   node scripts/outlayer-secret.mjs <game-contract-account> [--dry-run]
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const via = process.argv[2]
if (!via || !/^[a-z0-9._-]+\.testnet$/.test(via)) { console.error('usage: outlayer-secret.mjs <contract>.testnet [--dry-run]'); process.exit(2) }
const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]))
const key = env.NEARAI_API_KEY
if (!key) { console.error('NEARAI_API_KEY missing from .env.local'); process.exit(2) }
const fp = createHash('sha256').update(key).digest('hex').slice(0, 16)
const args = ['secrets', 'set', JSON.stringify({ NEARAI_API_KEY: key }), '--project', 'titleshot.testnet/titleshot-forge', '--profile', 'default', '--access', 'allow-all', '--via', via]
console.log(`outlayer secrets set {NEARAI_API_KEY:<key fp ${fp}>} --project titleshot.testnet/titleshot-forge --profile default --access allow-all --via ${via}`)
if (process.argv.includes('--dry-run')) process.exit(0)
const r = spawnSync(`${homedir()}/.cargo/bin/outlayer`, args, { env: { ...process.env, OUTLAYER_RPC_URL: process.env.OUTLAYER_RPC_URL ?? 'https://near-testnet.drpc.org' }, encoding: 'utf8' })
const scrub = (s) => (s ?? '').split(key).join('<redacted>')
process.stdout.write(scrub(r.stdout)); process.stderr.write(scrub(r.stderr))
process.exit(r.status ?? 1)
