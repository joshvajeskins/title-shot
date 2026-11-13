// Typed wrapper around the bout-sim wasm (JSON in, JSON out). Browser: `loadSim()`. Workers/tests: `loadSimSync(module)`.
import init, * as raw from './pkg/bout_sim.js'
import type { Spec as UiSpec } from '../game/types'

export interface RulebookMove { index: number; id: string; name: string; school: string; kind: string; power: number; accuracy: number; cooldown: number; cost: number; desc: string }
export interface RulebookRule { id: number; name: string; desc: string }
export interface Rulebook { version: string; hash: string; library: RulebookMove[]; rules: RulebookRule[]; limits: Record<string, number> }
export interface ChainSpec {
  name: string; title: string; look: string; cry: string; school: string; style: string
  moves: { id: string; label: string }[]
  stats: { power: number; guard: number; speed: number; grit: number }
}
export type SimError = { code: string; field?: string | null }
export interface SimFight { rounds: number; events: any[]; winner: 0 | 1 | 2; rounds_won: [number, number]; state_hash: string }

/** Counts from the wasm: `champion`/`challenger` are bout wins, `n` bouts were simulated. */
export interface SimOdds { n: number; champion: number; draw: number; challenger: number; champion_pct: number; draw_pct: number; challenger_pct: number }

export interface Sim {
  rulebook(): Rulebook
  requestParts(model: string): { prefix: string; suffix: string; rulebook_hash: string }
  buildRequest(model: string, sentence: string): string
  checkSentence(sentence: string): SimError | null
  normalize(rawJson: string): { ok: true; spec: ChainSpec } | { ok: false; error: SimError }
  simulate(champ: ChainSpec, chall: ChainSpec, seedHex: string, rule: number): { ok: true; fight: SimFight } | { ok: false; error: SimError }
  odds(champ: ChainSpec, chall: ChainSpec, seedHex: string, rule: number, n: number): SimOdds | null
}

function make(): Sim {
  let rb: Rulebook | null = null
  const j = (s: string) => JSON.parse(s)
  return {
    rulebook: () => (rb ??= j(raw.rulebook_json())),
    requestParts: (m) => j(raw.request_parts(m)),
    buildRequest: (m, s) => raw.build_request(m, s),
    checkSentence: (s) => { const r = j(raw.check_sentence(s)); return r.ok ? null : (r.error as SimError) },
    normalize: (r) => j(raw.normalize(r)),
    simulate: (a, b, seed, rule) => j(raw.simulate(JSON.stringify(a), JSON.stringify(b), seed, rule)),
    odds: (a, b, seed, rule, n) => { const r = j(raw.odds(JSON.stringify(a), JSON.stringify(b), seed, rule, n)); return r.ok ? r.odds : null },
  }
}

let ready: Promise<Sim> | null = null
let sync: Sim | null = null

/** Browser loader: fetches the wasm next to this module (Vite hashes and serves it). */
export function loadSim(): Promise<Sim> {
  if (sync) return Promise.resolve(sync)
  ready ??= init({ module_or_path: new URL('./pkg/bout_sim_bg.wasm', import.meta.url) }).then(() => (sync = make()))
  return ready
}

/** Workers / node: pass a compiled `WebAssembly.Module` or the wasm bytes. */
export function loadSimSync(module: WebAssembly.Module | BufferSource): Sim {
  if (!sync) {
    raw.initSync({ module })
    sync = make()
  }
  return sync
}

export const simIfReady = (): Sim | null => sync

/** Contract spec JSON -> UI Spec (move ids are the library ids on both sides). */
export function toUiSpec(spec: ChainSpec): UiSpec {
  return {
    name: spec.name, title: spec.title, look: spec.look, cry: spec.cry,
    school: spec.school as UiSpec['school'], style: spec.style as UiSpec['style'],
    moves: spec.moves.map((m) => ({ id: m.id, label: m.label })),
    stats: { ...spec.stats },
  }
}

/** UI Spec -> the spec JSON the wasm and the contract use. */
export function toChainSpec(spec: UiSpec): ChainSpec {
  return { name: spec.name, title: spec.title, look: spec.look, cry: spec.cry, school: spec.school, style: spec.style, moves: spec.moves.map((m) => ({ id: m.id, label: m.label })), stats: { ...spec.stats } }
}
