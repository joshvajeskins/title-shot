// GET /api/boxoffice/recent: the last 50 title shots bought through the box office (UI: "a challenger from Base" badge).
import { getJson } from '../../_lib/cache'
import { Chain } from '../../_lib/chain'
import { handle, json, methodGuard } from '../../_lib/http'
import { recentKey, type RecentBooking } from '../../_lib/boxofficeBook'

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['GET'])
  const chain = new Chain(env)
  return json({ bookings: (await getJson<RecentBooking[]>(env.TS_KV, recentKey(chain.id))) ?? [] }, 200, { 'cache-control': 'public, max-age=5' })
})
