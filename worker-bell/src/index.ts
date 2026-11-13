// title-shot-bell: a cron Worker whose only job is to ring the promoter tick on the Pages project every 5 minutes.
// Everything else (bell, payouts, Vance) lives in Pages Functions: this Worker holds no keys but the shared tick token.
export interface Env {
  PAGES_URL: string
  TICK_SECRET: string
}

export async function ring(env: Env, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${env.PAGES_URL.replace(/\/+$/, '')}/api/tick`
  let last = { ok: false, status: 0, body: 'no attempt' }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'x-tick-secret': env.TICK_SECRET } })
      const body = (await res.text()).slice(0, 400)
      last = { ok: res.ok, status: res.status, body }
      if (res.status < 500) return last // a 4xx will not get better by retrying
    } catch (e) {
      last = { ok: false, status: 0, body: String(e instanceof Error ? e.message : e).slice(0, 200) }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last
}

export default {
  async scheduled(_event: { scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(ring(env).then((r) => { if (!r.ok) console.error('tick failed', r.status, r.body) }))
  },
  async fetch(_req: Request, env: Env): Promise<Response> {
    return new Response(JSON.stringify({ name: 'title-shot-bell', target: env.PAGES_URL }), { headers: { 'content-type': 'application/json' } })
  },
}
