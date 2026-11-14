// scripts/rotate-nearai-key.sh: --dry-run prints every step in order and runs none (no vault, no wrangler, no near, no file
// written); bad input is refused before anything; the contract caps are floor(USD / 0.00064). set-env-key.mjs swaps the key
// in .env.local without printing it.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'rotate-'))
const marker = join(dir, 'ran')
const stub = join(dir, 'stub.sh')
writeFileSync(stub, `#!/bin/sh\necho "$0 $@" >> ${marker}\nexit 1\n`)
chmodSync(stub, 0o755)
const STUBS = { NEAR_BIN: stub, VAULT_INJECT: stub, WRANGLER_CMD: stub }
const envLocal = join(ROOT, '.env.local')
const snapshot = () => (existsSync(envLocal) ? readFileSync(envLocal, 'utf8') : null)

const rotate = (args: string[], env: Record<string, string> = { CONTRACT_ID: 'titleshot.testnet' }) =>
  spawnSync('bash', [join(ROOT, 'scripts/rotate-nearai-key.sh'), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...STUBS, ...env }, timeout: 30_000 })

describe('rotate-nearai-key.sh', () => {
  it('refuses missing or malformed numbers, a public total above the budget, a bad env and a bad CONTRACT_ID (nothing runs)', () => {
    const ok = ['--budget', '9', '--public-daily', '1', '--public-total', '8.5', '--dry-run']
    expect(rotate(['--budget', '9', '--public-daily', '1', '--dry-run']).status).toBe(2)
    expect(rotate(['--budget', '9; rm -rf /', '--public-daily', '1', '--public-total', '2', '--dry-run']).status).toBe(2)
    expect(rotate(['--budget', '1e3', '--public-daily', '1', '--public-total', '2', '--dry-run']).status).toBe(2)
    expect(rotate(['--budget', '0.1234567', '--public-daily', '0', '--public-total', '0', '--dry-run']).status).toBe(2)
    expect(rotate(['--budget', '1', '--public-daily', '1', '--public-total', '2', '--dry-run']).stderr).toMatch(/cannot exceed --budget/)
    expect(rotate([...ok, '--env', 'staging']).status).toBe(2)
    expect(rotate(ok, {}).status).toBe(2)
    expect(rotate(ok, { CONTRACT_ID: 'x; rm -rf /' }).status).toBe(2)
    expect(existsSync(marker)).toBe(false)
  })
  it('--dry-run prints every step in order and executes none; the caps are floor(USD / 0.00064)', () => {
    const before = snapshot()
    const r = rotate(['--budget', '9', '--public-daily', '1', '--public-total', '8.5', '--dry-run', '--network', 'testnet'])
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(marker)).toBe(false) // vault, wrangler and near were never invoked
    expect(snapshot()).toBe(before) // .env.local untouched
    const out = r.stdout
    expect(out).toContain('[DRY RUN: nothing is executed]')
    const steps = out.split('\n').filter((l) => l.startsWith('+ '))
    const order = [
      'get TITLE_SHOT_NEARAI_API_KEY --dir', 'replace NEARAI_API_KEY in .env.local',
      'pages secret put NEARAI_API_KEY --project-name title-shot --env production', 'pages secret put NEARAI_BUDGET_USD', 'pages secret put NEARAI_PUBLIC_DAILY_USD', 'pages secret put NEARAI_PUBLIC_TOTAL_USD',
      'outlayer-secret.mjs titleshot.testnet', 'titleshot.testnet reset_compile_counter', 'titleshot.testnet set_compile_caps', 'get_compile_caps', 'https://cloud-api.near.ai/v1/models',
    ]
    expect(steps.length).toBe(order.length)
    order.forEach((frag, i) => expect(steps[i]).toContain(frag))
    expect(out).toContain(`'{"daily":1562,"total":13281}'`) // floor(1/0.00064), floor(8.5/0.00064)
    expect(out).toContain("attached-deposit '1 yoctoNEAR' sign-as titleshot.testnet network-config testnet")
    expect(out).toContain('printf 9 |')
    expect(out).toContain('printf 8.5 |')
    expect(out).toContain('printf <key> |')
    expect(out).toContain('key fingerprint: <fingerprint after the vault read>')
  })
  it('the current key\'s limits give the documented caps (0.05/day -> 78, 0.25 total -> 390) and --env preview targets preview', () => {
    const r = rotate(['--budget', '2.5', '--public-daily', '0.05', '--public-total', '0.25', '--dry-run', '--env', 'preview'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`'{"daily":78,"total":390}'`)
    expect(r.stdout).toContain('--env preview')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('set-env-key.mjs', () => {
  const run = (keyFile: string, envFile: string) => spawnSync('node', [join(ROOT, 'scripts/set-env-key.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH!, KEYFILE: keyFile, ENVFILE: envFile } })
  it('replaces the key line, keeps the others, stays mode 600 and never prints the key', () => {
    const key = join(dir, 'key'), env = join(dir, 'env')
    writeFileSync(key, 'sk-new-key-value-123\n')
    writeFileSync(env, 'A=1\nNEARAI_API_KEY=sk-old\nB="two"\n')
    const r = run(key, env)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(env, 'utf8')).toBe('A=1\nNEARAI_API_KEY=sk-new-key-value-123\nB="two"\n')
    expect(statSync(env).mode & 0o777).toBe(0o600)
    expect(r.stdout + r.stderr).not.toContain('sk-new-key-value-123')
    expect(r.stdout + r.stderr).not.toContain('sk-old')
  })
  it('adds the key when missing; refuses an empty or odd key without echoing it', () => {
    const key = join(dir, 'key2'), env = join(dir, 'env2')
    writeFileSync(key, 'sk-added')
    writeFileSync(env, 'A=1')
    expect(run(key, env).status).toBe(0)
    expect(readFileSync(env, 'utf8')).toBe('A=1\nNEARAI_API_KEY=sk-added\n')
    writeFileSync(key, 'sk bad"value')
    const bad = run(key, env)
    expect(bad.status).toBe(1)
    expect(bad.stdout + bad.stderr).not.toContain('bad"value')
    expect(readFileSync(env, 'utf8')).toBe('A=1\nNEARAI_API_KEY=sk-added\n')
  })
})
