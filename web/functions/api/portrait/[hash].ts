import { maybeChain } from '../../_lib/chain'
import { handle, methodGuard, parseHashParam } from '../../_lib/http'
import { portraitFor } from '../../_lib/media'
import { enforce, RULES } from '../../_lib/ratelimit'

export const onRequest = handle(async ({ request, env, params }) => {
  methodGuard(request, ['GET'])
  const hash = parseHashParam(params.hash)
  const img = await portraitFor(env, maybeChain(env), hash, () => enforce(env.TS_KV, RULES.portraitGen, request))
  return new Response(img.bytes as BodyInit, { headers: { 'content-type': img.type, 'cache-control': 'public, max-age=31536000, immutable' } })
})
