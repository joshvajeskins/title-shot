#!/usr/bin/env node
// Reads near-cli's output of `get_deploy_gates` on stdin and exits 1 when the deploy is not usable:
//   production: any blocking gate (challenge() would refuse every call with E_NOT_READY)
//   staging:    any unmet gate other than forge_mode (staging runs in relayer mode on purpose)
// Usage: near ... get_deploy_gates ... | node scripts/check-gates.mjs <staging|production>
const mode = process.argv[2]
if (mode !== 'staging' && mode !== 'production') { console.error('usage: check-gates.mjs <staging|production>'); process.exit(2) }
let s = ''
process.stdin.on('data', (d) => { s += d }).on('end', () => {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '')
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}')
  let g
  try { g = JSON.parse(clean.slice(a, b + 1)) } catch { console.error('could not read get_deploy_gates output'); process.exit(1) }
  const failing = Array.isArray(g.failing) ? g.failing : []
  const bad = mode === 'production' ? failing.filter((x) => x.blocking) : failing.filter((x) => x.gate !== 'forge_mode')
  for (const x of failing) console.log(`  gate ${x.gate}${x.blocking ? ' (blocking)' : ''}: ${x.why}`)
  if (g.ready !== true || bad.length) {
    console.error(`NOT READY for ${mode}: ${bad.map((x) => x.gate).join(', ') || 'ready=false'}. Fix the gates (for production: VRF_PUBKEY_HEX, allowlist) and re-run; do not run cf-deploy.sh yet.`)
    process.exit(1)
  }
  console.log(`deploy gates OK for ${mode}${failing.length ? ` (non-blocking: ${failing.map((x) => x.gate).join(', ')})` : ''}`)
})
