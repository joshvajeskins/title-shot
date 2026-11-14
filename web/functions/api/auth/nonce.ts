import { rpcFor } from '../../_lib/chain'
import { ApiError, handle, json, methodGuard, parseBody } from '../../_lib/http'
import { issueNonce, nonceBody, recipientAllowed } from '../../_lib/nep413Auth'
import { enforce, type Rule } from '../../_lib/ratelimit'

const NONCE_RULE: Rule = { name: 'auth-nonce', limit: 30, windowSec: 600 }

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['POST'])
  const host = new URL(request.url).hostname
  if (!recipientAllowed(host, host)) throw new ApiError(400, 'BAD_HOST', 'Sign-in is not available on this address.')
  const body = await parseBody(request, nonceBody)
  await enforce(env.TS_KV, NONCE_RULE, request)
  return json(await issueNonce({ kv: env.TS_KV, rpc: rpcFor(env) }, body, host))
})
