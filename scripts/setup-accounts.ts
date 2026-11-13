// Create play / vance / relay sub-accounts of titleshot.testnet within a hard NEAR budget (default 3 NEAR in total).
//   npx tsx scripts/setup-accounts.ts            (run from web/ so tsx resolves: cd web && pnpm exec tsx ../scripts/setup-accounts.ts)
// Idempotent: existing accounts are skipped. New keys are stored under ~/.near-credentials/testnet (never in the repo).
import { Rpc, RpcError } from '../web/src/game/chain/rpc'
import { Signer, NEAR } from '../web/src/game/chain/signer'
import { loadCred, saveCred, generateKeyPair, formatPublicKey, ROOT_ACCOUNT } from './lib'

const PLAN: [string, bigint][] = [
  ['play.titleshot.testnet', (NEAR * 14n) / 10n],
  ['vance.titleshot.testnet', NEAR],
  ['relay.titleshot.testnet', (NEAR * 4n) / 10n],
]
const BUDGET = NEAR * 3n

async function main() {
  const rpc = new Rpc()
  const root = loadCred(ROOT_ACCOUNT)
  if (!root) throw new Error(`no credentials for ${ROOT_ACCOUNT}`)
  const signer = new Signer(ROOT_ACCOUNT, root.key, rpc)
  const total = PLAN.reduce((n, [, a]) => n + a, 0n)
  if (total > BUDGET) throw new Error('plan exceeds budget')
  for (const [id, amount] of PLAN) {
    const exists = await rpc.balance(id).then(() => true, (e) => { if (e instanceof RpcError) return false; throw e })
    if (exists) { console.log(`${id}: exists, skipped`); continue }
    const kp = loadCred(id)?.key ?? generateKeyPair()
    if (!loadCred(id)) saveCred(id, kp) // save before sending so a crash never loses the key
    const hash = await signer.send(id, [
      { kind: 'createAccount' },
      { kind: 'transfer', deposit: amount },
      { kind: 'addKeyFullAccess', publicKey: formatPublicKey(kp.publicKey) },
    ])
    const out = await signer.wait(hash, 60_000, 'EXECUTED_OPTIMISTIC')
    console.log(`${id}: ${out.failure ? 'FAILED ' + out.failure : 'created'} tx ${hash} (${Number(amount) / 1e24} NEAR)`)
  }
  for (const [id] of PLAN) console.log(id, Number(await rpc.balance(id).catch(() => 0n)) / 1e24, 'NEAR')
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
