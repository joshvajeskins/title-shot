// The promoter NPC and the bell. Idempotent: every action is guarded by contract state, one run per 20 s.
//   close_season -> sign_payout -> broadcast -> open the next season (Vance) -> relayer fallback / expiry sweep.
import { TGAS } from '../../src/game/chain/signer'
import type { RawBelt } from '../../src/game/chain/views'
import { compileFor } from './compiler'
import { getJson, putJson } from './cache'
import { fixPurseAddress, needsOpening, openStep } from './tickOpen'
import { payoutsStep } from './tickPayouts'
import { forgeChargeStep } from './tickForge'
import { houseStep } from './house'
import { Ledger } from './ledger'
import { detailOf, tickKey, type Log, type StepLog, type TickDeps, type TickLog } from './tickTypes'

export const THROTTLE_MS = 20_000
const SWEEP_BATCH = 12
const FORGE_TIMEOUT_MS = 10 * 60_000 + 5_000
const SWEEP_WINDOW = 30 // challenges older than this many ids are never revisited

/** The sweep cursor, clamped to [next - SWEEP_WINDOW, next]: a cursor from elsewhere can neither freeze nor rewind the sweep. */
export const clampCursor = (stored: number | null, next: number): number => {
  const lo = Math.max(0, next - SWEEP_WINDOW)
  return typeof stored === 'number' && Number.isInteger(stored) ? Math.min(Math.max(stored, lo), next) : lo
}

const safe = async (log: Log, belt: number | undefined, action: string, f: () => Promise<void>) => {
  try { await f() } catch (e) { log({ belt, action, ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 140) }) }
}

/** The bell: season over, nothing still forging -> close_season (anyone may call it). */
async function bellStep(d: TickDeps, log: Log, belt: RawBelt): Promise<void> {
  const s = belt.season
  if (!s || s.state !== 'Open') return
  if (d.now() < Number(BigInt(s.closes_at) / 1_000_000n) || s.pending > 0 || !d.sponsor) return
  const out = await d.sponsor.call(d.chain.id, 'close_season', { belt_id: belt.id }, 100n * TGAS, 0n, 60_000)
  log({ belt: belt.id, action: 'close_season', ok: !out.failure, detail: detailOf(out), tx: out.hash })
}

/** Relayer mode: deliver the signed NEAR AI compile for a challenge the contract is waiting on. True when submit_forge went through. */
async function relay(d: TickDeps, log: Log, id: number, sentence: string, model: string, needCompile: boolean): Promise<boolean> {
  if (!d.relayer) return false
  let output: Record<string, unknown> = { ok: true }
  if (needCompile) {
    // The relayed compile is counted by the contract (get_compile_caps) and charged by forgeChargeStep, so it is not
    // metered twice; but the key's hard stop still holds: past it, nothing is compiled (the challenge expires and refunds).
    const ledger = Ledger.of(d.env, { fetchFn: d.fetchFn, now: d.now })
    if (ledger) {
      const hold = await ledger.reserve('compile', model, 'tick').catch(() => null)
      if (!hold) { log({ action: `relay#${id}`, ok: false, detail: 'FORGE_CLOSED: NEAR AI budget used up' }); return false }
      await ledger.settle(hold, 'free')
    }
    const c = await compileFor(d.env, d.sim, model, sentence, d.fetchFn)
    output = { ok: true, response: c.response, signature: c.signed.signature, signing_address: c.signed.signing_address, signing_algo: c.signed.signing_algo, signature_kind: c.signed.signature_kind, text: c.signed.text }
  }
  const out = await d.relayer.call(d.chain.id, 'submit_forge', { challenge_id: id, output_json: JSON.stringify(output) }, 300n * TGAS, 0n, 90_000)
  log({ action: `submit_forge#${id}`, ok: !out.failure, detail: detailOf(out), tx: out.hash })
  return !out.failure
}

/**
 * Walk recent challenge ids: expire the ones past the forge timeout and relay pending ones (relayer mode). The cursor only
 * moves past a challenge that was handled; a failed relay or expiry holds it (and logs) so the next tick tries again.
 */
async function sweepStep(d: TickDeps, log: Log): Promise<void> {
  const kv = d.env.TS_KV
  const stats = await d.chain.stats()
  const next = stats.next_challenge_id
  let cursor = clampCursor(await getJson<number>(kv, tickKey(d, 'sweep:cursor')), next)
  const cfg = await d.chain.config()
  try {
    for (let n = 0; n < SWEEP_BATCH && cursor < next; n++) {
      const c = await d.chain.challenge(cursor)
      if (!c || c.status !== 'Forging') { cursor++; continue }
      const age = d.now() - Number(BigInt(c.created_at) / 1_000_000n)
      if (age > FORGE_TIMEOUT_MS && d.sponsor) {
        const out = await d.sponsor.call(d.chain.id, 'expire_challenge', { id: c.id }, 100n * TGAS, 0n, 60_000)
        log({ belt: c.belt_id, action: `expire_challenge#${c.id}`, ok: !out.failure, detail: detailOf(out), tx: out.hash })
        if (out.failure) break
        cursor++
        continue
      }
      if (c.relayer && cfg.forge_mode === 'relayer') {
        let ok = false
        await safe(log, c.belt_id, `relay#${c.id}`, async () => { ok = await relay(d, log, c.id, c.sentence, cfg.model_id, c.need_compile) })
        if (!ok) break // retried next tick, or expired once it is old enough
        cursor++
        continue
      }
      break // still young: look again next tick
    }
  } finally {
    await putJson(kv, tickKey(d, 'sweep:cursor'), cursor)
  }
}

export async function runTick(d: TickDeps, opts: { force?: boolean } = {}): Promise<TickLog> {
  const kv = d.env.TS_KV
  const t0 = d.now()
  const steps: StepLog[] = []
  const log: Log = (s) => steps.push(s)
  const finish = async (skipped?: string): Promise<TickLog> => {
    const out: TickLog = { at: t0, ms: d.now() - t0, steps, ...(skipped ? { skipped } : {}) }
    if (!skipped) await putJson(kv, tickKey(d, 'tick:last'), out)
    return out
  }
  const last = await getJson<number>(kv, tickKey(d, 'tick:last_at'))
  if (!opts.force && last && t0 - last < THROTTLE_MS) return finish('throttled')
  const lock = await getJson<number>(kv, tickKey(d, 'tick:lock'))
  if (lock && t0 - lock < 60_000) return finish('running')
  await putJson(kv, tickKey(d, 'tick:lock'), t0, 60)
  await putJson(kv, tickKey(d, 'tick:last_at'), t0)
  try {
    const belts = await d.chain.belts()
    for (const belt of belts) {
      await safe(log, belt.id, 'purse_address', () => fixPurseAddress(d, log, belt))
      await safe(log, belt.id, 'bell', () => bellStep(d, log, belt))
      if (belt.season) await safe(log, belt.id, 'payouts', () => payoutsStep(d, log, belt.id, belt.season!))
      // a new season may already be open while the last bell's payouts are still being signed or mined
      if (belt.season && belt.season.state !== 'Closed' && belt.season.id > 1) {
        await safe(log, belt.id, 'payouts(prev)', async () => {
          const prev = await d.chain.season(belt.id, belt.season!.id - 1)
          if (prev) await payoutsStep(d, log, belt.id, prev)
        })
      }
      if (needsOpening(belt, t0)) await safe(log, belt.id, 'open', () => openStep(d, log, belt))
    }
    await safe(log, undefined, 'forge_charge', () => forgeChargeStep(d, log))
    await safe(log, undefined, 'house', () => houseStep(d, log, belts)) // house challengers (docs/LIVENESS.md), before the relayer sweep
    await safe(log, undefined, 'sweep', () => sweepStep(d, log))
  } catch (e) {
    log({ action: 'tick', ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 140) })
  } finally {
    await putJson(kv, tickKey(d, 'tick:lock'), 0, 60)
  }
  return finish()
}
