import { tickDeps } from '../_lib/deps'
import { ApiError, handle, json, methodGuard, safeEqual } from '../_lib/http'
import { sim } from '../_lib/sim'
import { runTick } from '../_lib/tick'

// The bell Worker calls this every 5 minutes with the shared token. Lobby loads trigger the same tick lazily via /api/state.
export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['POST'])
  const given = request.headers.get('x-tick-secret') ?? ''
  if (!env.TICK_SECRET || !safeEqual(given, env.TICK_SECRET)) throw new ApiError(401, 'UNAUTHORIZED', 'Missing or wrong tick token.')
  if (!env.CONTRACT_ID) throw new ApiError(503, 'NOT_DEPLOYED', 'The game contract is not deployed yet.')
  return json(await runTick(tickDeps(env, sim())))
})
