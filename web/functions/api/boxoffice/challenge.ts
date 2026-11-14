// POST /api/boxoffice/challenge {belt, sentence}: x402 v2 paid title shot (docs/BOXOFFICE.md).
import { Chain } from '../../_lib/chain'
import { boxChallenge, boxDeps } from '../../_lib/boxoffice'
import { handle } from '../../_lib/http'

export const onRequest = handle(async ({ request, env, waitUntil }) => boxChallenge(boxDeps(env, new Chain(env), waitUntil), request))
