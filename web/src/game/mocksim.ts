// Placeholder fight generator used only until the bout-sim wasm build is wired in.
// Emits events in the exact bout-sim schema so the renderer is built against the real shape.
import type { FightEvent, Spec, Side } from './types'
import { FX } from './types'

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

export function mockFight(champ: Spec, chall: Spec, seed: number, rule = 0): { events: FightEvent[]; winner: 0 | 1 | 2 } {
  const r = rng(seed)
  const specs = [champ, chall]
  const maxHp: [number, number] = [80 + champ.stats.grit * 3, 80 + chall.stats.grit * 3]
  const ev: FightEvent[] = [{ t: 'match_start', rule, max_hp: maxHp }]
  const wins: [number, number] = [0, 0]
  for (let round = 1; round <= 3 && wins[0] < 2 && wins[1] < 2; round++) {
    ev.push({ t: 'round_start', round })
    const hp: [number, number] = [maxHp[0], maxHp[1]]
    const shield: [number, number] = [0, 0]
    const burn = [0, 0]
    const stunned = [false, false]
    let ko: Side | null = null
    for (let n = 1; n <= 10 && ko === null; n++) {
      const first: Side = specs[0].stats.speed + r() * 20 >= specs[1].stats.speed + r() * 20 ? 0 : 1
      ev.push({ t: 'exchange', round, n, first })
      for (const actor of [first, (1 - first) as Side]) {
        if (ko !== null) break
        if (stunned[actor]) { stunned[actor] = false; ev.push({ t: 'skip', actor }); continue }
        const foe = (1 - actor) as Side
        const s = specs[actor]
        const slot = Math.floor(r() * 3)
        const roll = r()
        let outcome: 'hit' | 'crit' | 'miss' | 'blocked' | 'used' = 'hit'
        let dmg = 0, absorbed = 0, heal = 0, fxFoe = 0, fxSelf = 0, hits = 1
        if (slot === 2 && r() < 0.35) {
          outcome = 'used'; hits = 0
          if (r() < 0.5) { shield[actor] = 14 + Math.floor(s.stats.guard / 2); fxSelf = FX.SHIELD }
          else { heal = Math.min(maxHp[actor] - hp[actor], 12 + Math.floor(r() * 10)); hp[actor] += heal }
        } else if (roll < 0.1) { outcome = 'miss'; hits = 0 }
        else {
          dmg = Math.round(9 + s.stats.power / 2.2 + r() * 10 - specs[foe].stats.guard / 6)
          if (roll > 0.86) { outcome = 'crit'; dmg = Math.round(dmg * 1.5) }
          if (shield[foe] > 0) { absorbed = Math.min(shield[foe], dmg); shield[foe] -= absorbed; dmg -= absorbed; if (dmg === 0) outcome = 'blocked' }
          hp[foe] = Math.max(0, hp[foe] - dmg)
          if (r() < 0.14) { fxFoe |= FX.STUN; stunned[foe] = true }
          if (s.school === 'BLAZE' && r() < 0.4) { fxFoe |= FX.BURN; burn[foe] = 3 }
          if (hp[foe] === 0) ko = foe
        }
        ev.push({ t: 'act', actor, slot, move_id: slot, outcome, hits, dmg, absorbed, heal, recoil: 0, hp: [hp[0], hp[1]], shield: [shield[0], shield[1]], fx_self: fxSelf, fx_foe: fxFoe })
      }
      for (const side of [0, 1] as Side[]) {
        if (ko !== null || burn[side] <= 0) continue
        burn[side]--
        const b = 5
        hp[side] = Math.max(0, hp[side] - b)
        ev.push({ t: 'upkeep', side, burn: b, hp: [hp[0], hp[1]], expired: burn[side] === 0 ? FX.BURN : 0 })
        if (hp[side] === 0) ko = side
      }
    }
    let w: 0 | 1 | 2
    if (ko !== null) w = (1 - ko) as 0 | 1
    else { const a = hp[0] * maxHp[1], b = hp[1] * maxHp[0]; w = a > b ? 0 : b > a ? 1 : 2 }
    if (w !== 2) wins[w]++
    ev.push({ t: 'round_end', round, winner: w, reason: ko !== null ? 'ko' : 'limit', hp: [hp[0], hp[1]] })
  }
  const winner: 0 | 1 | 2 = wins[0] > wins[1] ? 0 : wins[1] > wins[0] ? 1 : 2
  ev.push({ t: 'match_end', winner, rounds: wins })
  return { events: ev, winner }
}
