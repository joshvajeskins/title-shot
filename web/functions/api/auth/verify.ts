import { rpcFor } from '../../_lib/chain'
import { handle, json, methodGuard, parseBody } from '../../_lib/http'
import { verifyAuth, verifyBody } from '../../_lib/nep413Auth'
import { enforce, type Rule } from '../../_lib/ratelimit'

const VERIFY_RULE: Rule = { name: 'auth-verify', limit: 60, windowSec: 600 }

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['POST'])
  const body = await parseBody(request, verifyBody)
  await enforce(env.TS_KV, VERIFY_RULE, request)
  return json(await verifyAuth({ kv: env.TS_KV, rpc: rpcFor(env) }, body, new URL(request.url).hostname))
})
