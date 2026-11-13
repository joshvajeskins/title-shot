// Turns bout-sim events into timed beats: sound, camera and VFX cues. Pure helpers + an abortable clock.
import { sound } from '../audio/sound'
import type { Fight, FightEvent, School, Side } from '../game/types'
import { FX } from '../game/types'

export type Callout = { text: string; kind: 'round' | 'fight' | 'ko' | 'time' | 'draw' } | null
export interface Pop { id: number; side: Side; text: string; kind: 'dmg' | 'crit' | 'miss' | 'block' | 'heal' | 'burn' | 'status' }
export interface Status { burn: boolean; stun: boolean; shield: number; weaken: boolean; haste: boolean; counter: boolean; charge: boolean }
export const NO_STATUS: Status = { burn: false, stun: false, shield: 0, weaken: false, haste: false, counter: false, charge: false }

export class Clock {
  speed = 1
  aborted = false
  skipping = false
  wait(ms: number) {
    if (this.aborted) return Promise.reject(new Error('aborted'))
    if (this.skipping) return Promise.resolve()
    return new Promise<void>((res, rej) => setTimeout(() => (this.aborted ? rej(new Error('aborted')) : res()), ms / this.speed))
  }
}

export function moveLabel(f: Fight, side: Side, slot: number): string {
  const fighter = side === 0 ? f.champion : f.challenger
  if (slot === 3) return 'Haymaker'
  return fighter.spec.moves[slot]?.label ?? 'Strike'
}

export function fighterName(f: Fight, side: Side) {
  return (side === 0 ? f.champion : f.challenger).spec.name
}

export function schoolOf(f: Fight, side: Side): School {
  return (side === 0 ? f.champion : f.challenger).spec.school
}

const SCHOOL_SFX: Record<School, string> = { BLAZE: 'burn', TIDE: 'splash', VOLT: 'zap', IRON: 'clang', MIND: 'psychic', WILD: 'roar' }

/** Sound for one action, chosen from outcome, size and the attacker's school. */
export function actSound(ev: Extract<FightEvent, { t: 'act' }>, school: School) {
  switch (ev.outcome) {
    case 'miss': sound.pick('whoosh', 3); sound.play('miss_whiff'); return
    case 'blocked': sound.pick('block', 2); sound.play('shield'); return
    case 'countered': sound.pick('punch_heavy', 3); sound.play('clang'); return
    case 'used':
      if (ev.heal > 0) sound.play('heal')
      else if (ev.fx_self & FX.SHIELD) sound.play('shield')
      else sound.play(SCHOOL_SFX[school])
      return
    case 'crit': sound.play('crit'); sound.pick('punch_heavy', 3); sound.play('crowd_ooh', { volume: 0.7 }); break
    default: if (ev.dmg >= 18) sound.pick('punch_heavy', 3); else sound.pick('punch_light', 3)
  }
  if (ev.fx_foe & (FX.BURN | FX.STUN | FX.WEAKEN)) sound.play(SCHOOL_SFX[school], { volume: 0.7 })
}

export function applyFx(prev: Status, flags: number, on: boolean): Status {
  const s = { ...prev }
  if (flags & FX.BURN) s.burn = on
  if (flags & FX.STUN) s.stun = on
  if (flags & FX.WEAKEN) s.weaken = on
  if (flags & FX.HASTE) s.haste = on
  if (flags & FX.COUNTER) s.counter = on
  if (flags & FX.CHARGE) s.charge = on
  return s
}

export function fxNames(flags: number): string[] {
  const out: string[] = []
  if (flags & FX.BURN) out.push('Burning')
  if (flags & FX.STUN) out.push('Stunned')
  if (flags & FX.WEAKEN) out.push('Weakened')
  if (flags & FX.HASTE) out.push('Haste')
  if (flags & FX.COUNTER) out.push('Counter stance')
  if (flags & FX.CHARGE) out.push('Charging')
  if (flags & FX.SHIELD) out.push('Shielded')
  return out
}

export function roundVo(round: number, last: boolean) {
  sound.play('bell_ding')
  sound.play(last ? 'round_3' : round === 1 ? 'round_1' : 'round_2')
}
