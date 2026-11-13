import { maybeChain } from '../../_lib/chain'
import { handle, methodGuard, parseHashParam } from '../../_lib/http'
import { cryFor } from '../../_lib/media'
import { enforce, RULES } from '../../_lib/ratelimit'

export const onRequest = handle(async ({ request, env, params }) => {
  methodGuard(request, ['GET'])
  const hash = parseHashParam(params.hash)
  const cry = await cryFor(env, maybeChain(env), hash, () => enforce(env.TS_KV, RULES.cryGen, request))
  return new Response(cry.bytes as BodyInit, { headers: { 'content-type': cry.type, 'cache-control': 'public, max-age=31536000, immutable' } })
})
