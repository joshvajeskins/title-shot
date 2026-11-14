// The operator scripts: key generation never prints the key, the deploy scripts refuse bad input and, in --dry-run, print every
// command and execute none. The staging init arguments carry exactly the request bytes the wasm builds for the stand-in model.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, sim } from './helpers'
import { STANDIN_MODEL, standinAddress } from '../functions/_lib/standin'

const KEY = 'ab'.repeat(32)
const sh = (file: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [join(ROOT, 'scripts', file), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, timeout: 60_000 })

describe('gen-standin-key.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'standin-'))
  it('creates the key (mode 600), prints only the address, and never rotates an existing key', () => {
    const f = join(dir, 'env')
    writeFileSync(f, 'OTHER=1')
    const run = () => spawnSync('node', [join(ROOT, 'scripts/gen-standin-key.mjs'), '--file', f], { encoding: 'utf8' })
    const a = run()
    expect(a.status).toBe(0)
    const text = readFileSync(f, 'utf8')
    const key = /^STANDIN_SIGNER_KEY=([0-9a-f]{64})$/m.exec(text)![1]!
    expect(text.startsWith('OTHER=1\n')).toBe(true)
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(a.stdout.trim()).toBe(standinAddress(key))
    expect(a.stdout + a.stderr).not.toContain(key)
    const b = run()
    expect(b.stdout.trim()).toBe(a.stdout.trim())
    expect(readFileSync(f, 'utf8')).toBe(text)
  })
  it('a malformed key line is an error that does not echo the value', () => {
    const f = join(dir, 'bad')
    writeFileSync(f, 'STANDIN_SIGNER_KEY=not-hex-secret-value\n')
    const r = spawnSync('node', [join(ROOT, 'scripts/gen-standin-key.mjs'), '--file', f], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).not.toContain('not-hex-secret-value')
  })
})

describe('deploy-contract.sh', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'near-stub-')), 'ran')
  const stub = join(tmpdir(), `near-stub-${process.pid}.sh`)
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${marker}\nexit 1\n`)
  chmodSync(stub, 0o755)
  const env = { STANDIN_SIGNER_KEY: KEY, NEAR_BIN: stub }

  it('refuses a missing --fund, a non-sub-account, an unknown mode and a non-numeric amount (nothing runs)', () => {
    expect(sh('deploy-contract.sh', ['staging.titleshot.testnet', 'staging'], env).status).toBe(2)
    expect(sh('deploy-contract.sh', ['other.testnet', 'staging', '--fund', '8', '--dry-run'], env).status).toBe(2)
    expect(sh('deploy-contract.sh', ['staging.titleshot.testnet', 'beta', '--fund', '8', '--dry-run'], env).status).toBe(2)
    expect(sh('deploy-contract.sh', ['staging.titleshot.testnet', 'staging', '--fund', '8; rm -rf /', '--dry-run'], env).status).toBe(2)
    expect(existsSync(marker)).toBe(false)
  })
  it('--dry-run (staging) prints every command in order and executes none', () => {
    const r = sh('deploy-contract.sh', ['staging.titleshot.testnet', 'staging', '--fund', '8', '--dry-run'], env)
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(marker)).toBe(false)
    const cmds = r.stdout.split('\n').filter((l) => l.startsWith(`+ ${stub}`))
    const kinds = cmds.map((c) => /(create-account|contract deploy|call-function as-transaction \S+ (\w+)|call-function as-read-only \S+ (\w+))/.exec(c)?.[0] ?? c)
    expect(kinds.map((k) => k.replace(/ \S+\.testnet/, ''))).toEqual([
      'create-account', 'contract deploy', 'call-function as-transaction add_relayer',
      'call-function as-transaction create_belt', 'call-function as-transaction create_belt', 'call-function as-transaction create_belt',
      'call-function as-read-only get_deploy_gates',
    ])
    expect(r.stdout).toContain("'8 NEAR'")
    expect(r.stdout).toContain('sign-as titleshot.testnet')
    expect(r.stdout).toContain('The Midnight Belt')
    expect(r.stdout).toContain('The Tide Belt')
    expect(r.stdout).toContain('The Wildcard Belt')
    expect(r.stdout).toContain('"toll":"50000000000000000000000"')
    expect(r.stdout).toContain('"forge_fee":"10000000000000000000000"') // the contract's MIN_FORGE_FEE
    expect(r.stdout).toContain('relay.titleshot.testnet')
    expect(r.stdout).toContain('vance.titleshot.testnet')
    expect(r.stdout).not.toContain(KEY)
  })
  it('the init JSON is staging: relayer mode, the stand-in as the only signer, and the exact request bytes of the wasm', () => {
    const r = sh('deploy-contract.sh', ['staging.titleshot.testnet', 'staging', '--fund', '8', '--dry-run'], env)
    const line = r.stdout.split('\n').find((l) => l.includes('contract deploy'))!
    const json = /json-args '(\{.*?\})' prepaid-gas/.exec(line)![1]!
    const a = JSON.parse(json)
    const parts = sim().requestParts(STANDIN_MODEL)
    expect(a).toMatchObject({
      owner: 'titleshot.testnet', outlayer: 'outlayer.testnet', forge_project: 'titleshot.testnet/titleshot-forge', mpc_signer: 'v1.signer-prod.testnet',
      model_id: STANDIN_MODEL, signature_kind: 'provider_tee', forge_mode: 'relayer', allowlist_delay_sec: 0, signer_allowlist: [standinAddress(KEY)],
    })
    expect(Buffer.from(a.req_prefix, 'base64').toString('utf8')).toBe(parts.prefix)
    expect(Buffer.from(a.req_suffix, 'base64').toString('utf8')).toBe(parts.suffix)
  })
})

describe('cf-deploy.sh', () => {
  const toml = join(ROOT, 'web/wrangler.toml')
  it('refuses a missing or malformed CONTRACT_ID and a bad mode', () => {
    expect(sh('cf-deploy.sh', ['staging', '--dry-run']).status).toBe(2)
    expect(sh('cf-deploy.sh', ['staging', '--dry-run'], { CONTRACT_ID: 'x; rm -rf /' }).status).toBe(2)
    expect(sh('cf-deploy.sh', ['beta', '--dry-run'], { CONTRACT_ID: 'staging.titleshot.testnet' }).status).toBe(2)
  })
  it('--dry-run prints the build, vars, secret push and deploy, leaves wrangler.toml untouched and never prints the key', () => {
    const before = readFileSync(toml, 'utf8')
    const r = sh('cf-deploy.sh', ['staging', '--dry-run'], { CONTRACT_ID: 'staging.titleshot.testnet' })
    // the key lives in the repo .env.local on the coordinator's machine; in a clean checkout the script stops before the secret step
    if (r.status === 0) {
      expect(r.stdout).toContain('VITE_CONTRACT_ID=staging.titleshot.testnet pnpm build')
      expect(r.stdout).toContain('COMPILER_MODE="standin"')
      expect(r.stdout).toContain('pages secret put STANDIN_SIGNER_KEY --project-name title-shot --env preview')
      expect(r.stdout).toContain('pages deploy dist --project-name title-shot --branch preview')
    } else {
      expect(r.stderr).toContain('STANDIN_SIGNER_KEY is not in .env.local')
    }
    const prod = sh('cf-deploy.sh', ['production', '--dry-run', '--branch', 'main'], { CONTRACT_ID: 'titleshot.testnet' })
    expect(prod.status, prod.stderr).toBe(0)
    expect(prod.stdout).toContain('COMPILER_MODE=""')
    expect(prod.stdout).not.toContain('STANDIN_SIGNER_KEY')
    expect(prod.stdout).toContain('--branch main')
    expect(readFileSync(toml, 'utf8')).toBe(before)
    expect(existsSync(toml + '.deploy-bak')).toBe(false)
  })
})
