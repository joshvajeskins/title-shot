// Shared helpers for the operator scripts (node only). Secrets are read from ~/.near-credentials and .env.local, never printed.
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSecretKey, formatSecretKey, formatPublicKey, generateKeyPair, type KeyPair } from '../web/src/game/chain/keys'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CRED_DIR = join(homedir(), '.near-credentials', 'testnet')
export const ROOT_ACCOUNT = 'titleshot.testnet'

export function loadCred(accountId: string): { secret: string; key: KeyPair } | null {
  const f = join(CRED_DIR, `${accountId}.json`)
  if (!existsSync(f)) return null
  const j = JSON.parse(readFileSync(f, 'utf8'))
  const secret = String(j.private_key ?? j.secret_key ?? '')
  return { secret, key: parseSecretKey(secret) }
}

export function saveCred(accountId: string, kp: KeyPair) {
  mkdirSync(CRED_DIR, { recursive: true })
  const f = join(CRED_DIR, `${accountId}.json`)
  writeFileSync(f, JSON.stringify({ account_id: accountId, public_key: formatPublicKey(kp.publicKey), private_key: formatSecretKey(kp) }, null, 2))
  chmodSync(f, 0o600)
}

export function envLocal(name: string): string | null {
  if (process.env[name]) return process.env[name]!
  const p = join(ROOT, '.env.local')
  if (!existsSync(p)) return null
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
    if (m) return m[1]!.replace(/^["']|["']$/g, '') || null
  }
  return null
}

export { generateKeyPair, formatPublicKey }
