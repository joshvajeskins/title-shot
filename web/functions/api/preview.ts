import { maybeChain } from '../_lib/chain'
import { clientIp, handle, json, methodGuard, parseBody } from '../_lib/http'
import { runPreview, previewBody } from '../_lib/preview'
import { enforce, RULES } from '../_lib/ratelimit'
import { sim } from '../_lib/sim'

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['POST'])
  const ip = clientIp(request)
  await enforce(env.TS_KV, RULES.previewMin, request, ip)
  await enforce(env.TS_KV, RULES.previewDay, request, ip)
  const { sentence } = await parseBody(request, previewBody)
  return json(await runPreview({ env, sim: sim(), chain: maybeChain(env), fetchFn: (...a) => fetch(...a) }, sentence))
})
