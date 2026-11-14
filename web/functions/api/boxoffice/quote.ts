// GET /api/boxoffice/quote[?belt=N]: the free quote for a paid title shot (price, payTo, belt state). docs/BOXOFFICE.md
import { z } from 'zod'
import type { RawBelt } from '../../../src/game/chain/views'
import { cachedJson, scoped } from '../../_lib/cache'
import { Chain } from '../../_lib/chain'
import { ApiError, handle, json, methodGuard } from '../../_lib/http'
import { enforce } from '../../_lib/ratelimit'
import { beltQuote, boxConfig, payToOf, quoteBody } from '../../_lib/boxofficeQuote'

const beltParam = z.coerce.number().int().min(1).max(10_000)
const QUOTE_RULE = { name: 'box-quote', limit: 60, windowSec: 60 }

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['GET'])
  await enforce(env.TS_KV, QUOTE_RULE, request)
  const url = new URL(request.url)
  const raw = url.searchParams.get('belt')
  const belt = raw === null ? null : beltParam.safeParse(raw)
  if (belt && !belt.success) throw new ApiError(400, 'BAD_INPUT', 'belt: expected a belt number like 1.')
  const chain = new Chain(env)
  const cfg = boxConfig(env)
  const [payTo, belts] = await Promise.all([payToOf(env, chain), cachedJson(env.TS_KV, scoped(chain.id, 'boxoffice:belts'), 3, () => chain.belts())])
  const now = Date.now()
  const pick: RawBelt[] = belt ? belts.filter((b) => b.id === belt.data) : belts
  if (belt && !pick.length) throw new ApiError(404, 'NO_BELT', 'That belt does not exist.')
  const body = quoteBody(cfg, payTo, `${url.origin}/api/boxoffice/challenge`, pick.map((b) => beltQuote(b, now)), chain.id)
  return json(belt ? { ...body, belt: body.belts[0] } : body)
})
