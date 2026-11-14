import { maybeChain } from '../../_lib/chain'
import { handle, methodGuard, parseHashParam } from '../../_lib/http'
import { whoOf } from '../../_lib/ledger'
import { portraitFor } from '../../_lib/media'
import { enforce, RULES } from '../../_lib/ratelimit'

// Budget exhausted: 404 {code:'PORTRAIT_BUDGET'} (the UI shows a labelled stock emblem). Receipts: /api/portrait/:hash/meta.
export const onRequest = handle(async ({ request, env, params, waitUntil }) => {
  methodGuard(request, ['GET'])
  const hash = parseHashParam(params.hash)
  const img = await portraitFor(env, maybeChain(env), hash, () => enforce(env.TS_KV, RULES.portraitGen, request), (...a) => fetch(...a), { who: whoOf(request, env), ledger: { defer: waitUntil } })
  return new Response(img.bytes as BodyInit, { headers: { 'content-type': img.type, 'cache-control': 'public, max-age=31536000, immutable' } })
})
