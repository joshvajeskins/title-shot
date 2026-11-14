import { Chain, rpcFor } from '../_lib/chain'
import { signerFrom } from '../_lib/deps'
import { DEFAULTS } from '../_lib/env'
import { ApiError, handle, json, methodGuard, parseBody } from '../_lib/http'
import { createGuest, economicsOf, guestBody, knownGuest } from '../_lib/guest'
import { admit, serialize } from '../_lib/lane'
import { enforce, RULES } from '../_lib/ratelimit'

const MAX_QUEUED = 3 // guests being created on this isolate at once; each costs ~0.5 NEAR, so a burst waits or is refused

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['POST'])
  // The slot is taken before the first await: the check and the increment are one synchronous step, so a burst cannot all pass the check.
  const release = admit('sponsor-guest', MAX_QUEUED)
  if (!release) throw new ApiError(429, 'BUSY', 'Lots of new players at once. Try again in a few seconds.', 5)
  try {
    const body = await parseBody(request, guestBody)
    const near = rpcFor(env)
    const chain = new Chain(env, near)
    const sponsor = signerFrom(env.SPONSOR_ID ?? DEFAULTS.sponsorId, env.SPONSOR_KEY, near)
    if (!sponsor) throw new ApiError(503, 'SPONSOR_DRY', 'The guest faucet is not configured.')
    // a retry of a guest this key already started resumes it (no new account, no new funding), so it does not use up a slot
    if (!(await knownGuest(env.TS_KV, chain.id, body.publicKey))) {
      await enforce(env.TS_KV, RULES.guestIp, request)
      await enforce(env.TS_KV, RULES.guestGlobal, request, 'all')
    }
    // one at a time: the balance floor is re-read before every account, so a burst cannot overshoot it (nor race the sponsor's nonce)
    return json(await serialize('sponsor-guest', () => createGuest({ sponsor, near, contract: chain.id, kv: env.TS_KV, ...economicsOf(env) }, body)))
  } finally {
    release()
  }
})
