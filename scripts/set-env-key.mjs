#!/usr/bin/env node
// Replace (or add) NEARAI_API_KEY in an env file with the value in KEYFILE. Used by rotate-nearai-key.sh: the key travels by
// file, never argv or output. Other lines are kept as they are; the file stays mode 600.
//   KEYFILE=<file holding the key> ENVFILE=<path to .env.local> node scripts/set-env-key.mjs
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const keyFile = process.env.KEYFILE, envFile = process.env.ENVFILE
if (!keyFile || !envFile) { console.error('set KEYFILE and ENVFILE'); process.exit(2) }
const key = readFileSync(keyFile, 'utf8').trim()
if (!key || /[\s"'\\]/.test(key)) { console.error('the key file is empty or holds an unexpected character'); process.exit(1) }
const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : []
if (lines.length && lines[lines.length - 1] === '') lines.pop()
let found = false
const out = lines.map((l) => (/^NEARAI_API_KEY=/.test(l) ? ((found = true), `NEARAI_API_KEY=${key}`) : l))
if (!found) out.push(`NEARAI_API_KEY=${key}`)
writeFileSync(envFile, out.join('\n') + '\n', { mode: 0o600 })
chmodSync(envFile, 0o600)
console.log(`NEARAI_API_KEY ${found ? 'replaced' : 'added'} in ${envFile.split('/').pop()}`)
