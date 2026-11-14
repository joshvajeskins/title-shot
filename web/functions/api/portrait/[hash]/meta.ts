import { ApiError, handle, json, methodGuard, parseHashParam } from '../../../_lib/http'
import { portraitMeta } from '../../../_lib/media'
import { enforce, RULES } from '../../../_lib/ratelimit'

// GET /api/portrait/:hash/meta: how the portrait was generated (model, seed, size) and NEAR AI's provider_tee signature over
// that exchange, for the receipts UI. A KV read only; 404 NO_META until the portrait has been generated here.
export const onRequest = handle(async ({ request, env, params }) => {
  methodGuard(request, ['GET'])
  await enforce(env.TS_KV, RULES.stateMin, request, undefined, 'open')
  const meta = await portraitMeta(env.TS_KV, parseHashParam(params.hash))
  if (!meta) throw new ApiError(404, 'NO_META', 'This portrait has no generation record.')
  return json(meta, 200, { 'cache-control': 'public, max-age=300' })
})
