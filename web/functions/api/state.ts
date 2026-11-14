import { baseRpcFor, rpcFor } from '../_lib/chain'
import { cachedJson, scoped } from '../_lib/cache'
import { handle, json, methodGuard } from '../_lib/http'
import { enforce, RULES } from '../_lib/ratelimit'
import { sim } from '../_lib/sim'
import { buildState } from '../_lib/state'
import { runTick } from '../_lib/tick'
import { tickDeps } from '../_lib/deps'

// One JSON for the whole lobby, cached 3 s so browsers never hammer RPC. A lobby load also nudges the (throttled) tick.
export const onRequest = handle(async ({ request, env, waitUntil }) => {
  methodGuard(request, ['GET'])
  await enforce(env.TS_KV, RULES.stateMin, request, undefined, 'open') // a broken counter store must never take the lobby down
  const s = sim()
  const data = await cachedJson(env.TS_KV, scoped(env.CONTRACT_ID, 'state:v1'), 3, () => buildState(env, s, rpcFor(env), baseRpcFor(env)), 8)
  if (env.CONTRACT_ID) waitUntil(runTick(tickDeps(env, s)).catch(() => undefined))
  return json(data, 200, { 'cache-control': 'public, max-age=2' })
})
