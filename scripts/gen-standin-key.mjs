#!/usr/bin/env node
// Creates the staging stand-in referee's secp256k1 signing key in .env.local (STANDIN_SIGNER_KEY=<64 hex>, mode 600) when it is
// absent, and prints ONLY its Ethereum address (what staging.titleshot.testnet lists as its AI signer). The key is never printed.
//   node scripts/gen-standin-key.mjs                 create if absent, print the address
//   node scripts/gen-standin-key.mjs --address       same (never rotates an existing key)
//   node scripts/gen-standin-key.mjs --file <p>  use another env file (tests)
// Rotating the key means a new allowlist on the contract: delete the line in .env.local on purpose, run again, then re-deploy.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '../web/node_modules/@noble/curves/secp256k1.js'
import { keccak_256 } from '../web/node_modules/@noble/hashes/sha3.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const at = args.indexOf('--file')
const file = at >= 0 && args[at + 1] ? args[at + 1] : join(root, '.env.local')
const NAME = 'STANDIN_SIGNER_KEY'

const hex = (b) => Buffer.from(b).toString('hex')
const addressOf = (keyHex) => '0x' + hex(keccak_256(secp256k1.getPublicKey(Buffer.from(keyHex, 'hex'), false).slice(1)).slice(12))

const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
const line = text.split('\n').find((l) => new RegExp(`^\\s*${NAME}\\s*=`).test(l))
let key = line ? line.replace(/^[^=]*=\s*/, '').replace(/^["']|["']$/g, '').replace(/^0x/i, '').trim() : ''
if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error(`${NAME} in ${file} is not 32 bytes of hex; fix or remove that line (the value is not shown).`)
  process.exit(1)
}
if (!key) {
  do { key = randomBytes(32).toString('hex') } while (!secp256k1.utils.isValidSecretKey(Buffer.from(key, 'hex')))
  const sep = text && !text.endsWith('\n') ? '\n' : ''
  writeFileSync(file, `${text}${sep}${NAME}=${key}\n`)
  chmodSync(file, 0o600)
  console.error(`${NAME} created in ${file} (value not shown)`)
}
console.log(addressOf(key))
