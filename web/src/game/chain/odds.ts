// "Your odds" from the bout-sim wasm. Rule 255 = unknown (sealed): average over all 8 arena rules.
import { sha256 } from '@noble/hashes/sha2.js'
import { toHex, utf8 } from './bytes'
import { toChainSpec, type Sim } from '../../sim'
import type { Odds, Spec } from '../types'

export const SEALED_RULE = 255
const RULE_COUNT = 8

export function computeOdds(sim: Sim, champion: Spec, challenger: Spec, rule: number, n = 200): Odds {
  const champ = toChainSpec(champion)
  const chall = toChainSpec(challenger)
  const seed = toHex(sha256(utf8(`odds|${champion.name}|${champion.look}|${challenger.name}|${challenger.look}`)))
  const rules = rule === SEALED_RULE ? Array.from({ length: RULE_COUNT }, (_, i) => i) : [rule]
  const per = Math.max(1, Math.floor(n / rules.length))
  let total = 0, win = 0, draw = 0, loss = 0
  for (const r of rules) {
    const o = sim.odds(champ, chall, seed, r, per)
    if (!o) continue
    total += o.n; win += o.challenger; draw += o.draw; loss += o.champion
  }
  if (total === 0) return { win: 0, draw: 0, loss: 0, n: 0 }
  return { win: win / total, draw: draw / total, loss: loss / total, n: total }
}
