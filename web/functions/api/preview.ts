import { maybeChain } from '../_lib/chain'
import { clientIp, handle, json, methodGuard, parseBody } from '../_lib/http'
import { whoOf } from '../_lib/ledger'
import { runPreview, previewBody } from '../_lib/preview'
import { enforce, RULES } from '../_lib/ratelimit'
import { sim } from '../_lib/sim'

// Budget exhausted (docs/BUDGET.md): 503 {code:'FORGE_CLOSED'}. Owner/test traffic sends x-tick-secret (skips the public caps only).
export const onRequest = handle(async ({ request, env, waitUntil }) => {
  methodGuard(request, ['POST'])
  const ip = clientIp(request)
  await enforce(env.TS_KV, RULES.previewMin, request, ip)
  await enforce(env.TS_KV, RULES.previewDay, request, ip)
  const { sentence } = await parseBody(request, previewBody)
  return json(await runPreview({ env, sim: sim(), chain: maybeChain(env), fetchFn: (...a) => fetch(...a), who: whoOf(request, env), ledger: { defer: waitUntil } }, sentence))
})
