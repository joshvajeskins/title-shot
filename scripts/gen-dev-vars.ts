// Writes web/.dev.vars (gitignored) for local `wrangler pages dev`: role keys from ~/.near-credentials, API keys from .env.local.
// Values are never printed. Run from web/:  pnpm exec tsx ../scripts/gen-dev-vars.ts
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ROOT, envLocal, loadCred } from './lib'

const out = join(ROOT, 'web', '.dev.vars')
const prev = new Map<string, string>()
if (existsSync(out)) for (const l of readFileSync(out, 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) prev.set(m[1]!, m[2]!) }

const vars: [string, string | null][] = [
  ['SPONSOR_KEY', loadCred('play.titleshot.testnet')?.secret ?? null],
  ['VANCE_KEY', loadCred('vance.titleshot.testnet')?.secret ?? null],
  ['RELAYER_KEY', loadCred('relay.titleshot.testnet')?.secret ?? null],
  ['NEARAI_API_KEY', envLocal('NEARAI_API_KEY')],
  ['ELEVENLABS_API_KEY', envLocal('ELEVENLABS_API_KEY')],
  ['TICK_SECRET', prev.get('TICK_SECRET') ?? randomBytes(24).toString('hex')],
  ['CONTRACT_ID', process.env.TS_CONTRACT_ID ?? prev.get('CONTRACT_ID') ?? null],
]
const lines = vars.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)
writeFileSync(out, lines.join('\n') + '\n')
chmodSync(out, 0o600)
console.log('wrote web/.dev.vars with:', vars.map(([k, v]) => `${k}${v ? '' : ' (missing)'}`).join(', '))
