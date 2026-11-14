// The tick charges contract forges to the spend ledger: players call OutLayer through the contract, so the worker never sees
// those NEAR AI calls. The contract counts them (get_compile_caps().used, reset on key rotation); each new one is charged at
// the worst-case compile cost under kind 'forge' as public spend (players caused it).
import { getJson, putJson } from './cache'
import { Ledger } from './ledger'
import { toNano, WORST_COMPILE_USD } from './pricing'
import { tickKey, type Log, type TickDeps } from './tickTypes'

export const forgeSeenKey = (d: TickDeps, fp: string) => tickKey(d, `ledger:${fp}:forge-seen`)

/**
 * New compiles since the last tick: `used - seen`. A first look at this key (or a counter below the last one: it was reset)
 * charges all of `used`, since the rotate script resets the counter together with the new key. Charged before the cursor
 * moves, so a failed cursor write charges twice (too much), never zero times.
 */
export async function forgeChargeStep(d: TickDeps, log: Log): Promise<void> {
  const ledger = Ledger.of(d.env, { fetchFn: d.fetchFn, now: d.now })
  if (!ledger || typeof d.chain.compileCaps !== 'function') return
  const caps = await d.chain.compileCaps()
  const used = Number(caps?.used)
  if (!Number.isInteger(used) || used < 0) throw new Error('E_COMPILE_CAPS: unreadable counter')
  const key = forgeSeenKey(d, ledger.fp)
  const seen = await getJson<number>(d.env.TS_KV, key)
  const fresh = typeof seen !== 'number' || used < seen ? used : used - seen
  if (fresh > 0) {
    const cfg = await d.chain.config().catch(() => null)
    await ledger.charge('forge', cfg?.model_id ?? 'unknown', 'public', fresh * toNano(WORST_COMPILE_USD), fresh)
    // the cursor only moves once the charge is in KV (a lost isolate must not leave forges uncharged)
    if (!(await ledger.flush().then(() => true, () => false))) throw new Error('LEDGER_WRITE: forge charge kept in memory, cursor held')
    log({ action: 'forge_charge', ok: true, detail: `${fresh} contract compile${fresh === 1 ? '' : 's'} charged at worst case` })
  }
  if (seen !== used) await putJson(d.env.TS_KV, key, used)
}
