// Stand-in fighter specs (staging only): a roster sentence returns its curated archetype; any other sentence gets a deterministic
// spec built from its own words, seeded by sha256(sentence). Output is the raw model JSON that `normalize` accepts.
import { sha256 } from '@noble/hashes/sha2.js'
import roster from '../../../crates/bout-sim/fixtures/archetypes.json'
import { utf8 } from '../../src/game/chain/bytes'
import { cleanSentence } from '../../src/game/sentence'
import type { RulebookMove, Sim } from '../../src/sim'

export type RawSpec = Record<string, unknown>
const key = (s: string) => cleanSentence(s).toLowerCase()
const rosterMap = new Map((roster as { sentence: string; raw: RawSpec }[]).map((a) => [key(a.sentence), a.raw]))

/** The archetype's raw JSON when the sentence is a roster sentence (case-insensitive, whitespace cleaned). */
export const rosterRaw = (sentence: string): RawSpec | null => rosterMap.get(key(sentence)) ?? null

/** The opener sentences Vance uses in stand-in mode: exact roster sentences. */
export const STANDIN_OPENERS = [
  'a grandma who never stops knitting',
  'a very polite kraken',
  "the world's angriest goose",
  'a skeleton who is late for work',
  'a librarian who bans noise',
  'a raccoon running a casino',
]

const SCHOOLS: [string, string[]][] = [
  ['BLAZE', ['fire', 'flame', 'burn', 'dragon', 'toast', 'lava', 'ember', 'inferno', 'volcano', 'hot', 'spicy', 'devil', 'sun', 'pizza', 'barista', 'coffee', 'angry']],
  ['TIDE', ['water', 'sea', 'ocean', 'fish', 'kraken', 'wave', 'swim', 'rain', 'ice', 'frost', 'snow', 'pirate', 'duck', 'jelly', 'lifeguard', 'soup', 'river', 'wind']],
  ['VOLT', ['electric', 'thunder', 'storm', 'spark', 'robot', 'battery', 'lightning', 'cloud', 'disco', 'cart', 'moth', 'rocket', 'laser', 'neon', 'wifi', 'karaoke']],
  ['IRON', ['metal', 'iron', 'steel', 'knight', 'armor', 'armour', 'tank', 'mountain', 'rock', 'stone', 'machine', 'mime', 'skeleton', 'tin', 'anvil', 'castle', 'shield']],
  ['MIND', ['wizard', 'brain', 'ghost', 'book', 'smart', 'genius', 'librarian', 'chess', 'spell', 'psychic', 'dream', 'philosopher', 'lawyer', 'professor', 'planner', 'owl', 'haunted']],
  ['WILD', ['animal', 'beast', 'cat', 'dog', 'plant', 'tree', 'goose', 'raccoon', 'wolf', 'bear', 'hedgehog', 'scarecrow', 'jungle', 'forest', 'snail', 'monkey', 'bird']],
]
const STYLES = ['BRAWLER', 'TACTICIAN', 'COUNTERPUNCHER', 'SHOWBOAT']
const PALETTE: Record<string, string> = {
  BLAZE: 'ember red and gold', TIDE: 'deep teal and foam white', VOLT: 'electric yellow and violet',
  IRON: 'steel grey and rust', MIND: 'indigo and moonlight silver', WILD: 'moss green and amber',
}
const EPITHETS = ['Menace', 'Terror', 'Legend', 'Scourge', 'Champion', 'Nightmare', 'Hero', 'Wonder']
const CRIES = [(w: string) => `Fear the ${w}!`, (w: string) => `${w} time!`, (w: string) => `No mercy for the ${w}!`, (w: string) => `Bow to the ${w}!`]
const STOP = new Set('a an the who that which with of in on at to for and or but is are was be it its his her their my your our has have had as by from this these those not never only just very all one into than then when where while about over under'.split(' '))

const cap = (s: string, n: number) => Array.from(s).slice(0, n).join('').trim()
const titleCase = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)
const words = (s: string) => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []

function schoolFor(lower: string, h: Uint8Array, names: string[]): string {
  let best = ''
  let score = 0
  for (const [name, keys] of SCHOOLS) {
    const n = keys.filter((k) => lower.includes(k)).length
    if (n > score && names.includes(name)) { best = name; score = n }
  }
  return best || names[h[0]! % names.length]!
}

const pick = <T>(list: T[], h: Uint8Array, i: number): T => list[((h[i]! << 8) | h[i + 1]!) % list.length]!

/** Deterministic raw spec for a non-roster sentence. Pure function of the sentence and the rulebook library. */
export function buildRaw(sim: Sim, input: string): RawSpec {
  const sentence = cleanSentence(input)
  const h = sha256(utf8(sentence))
  const lib: RulebookMove[] = sim.rulebook().library
  const school = schoolFor(sentence.toLowerCase(), h, [...new Set(lib.map((m) => m.school))])
  const all = words(sentence)
  const content = all.filter((w) => !STOP.has(w.toLowerCase()))
  const ws = content.length ? content : all
  const plain = ws.filter((w) => /^\p{L}[\p{L}'’-]*$/u.test(w))
  const cryWord = titleCase(plain[plain.length - 1] ?? 'champion')

  const name = ws.length ? cap(ws.slice(0, 2).map(titleCase).join(' '), 24) : 'Mystery Contender'
  const last = ws.length ? titleCase(ws[ws.length - 1]!) : 'Mystery'
  const title = cap(`The ${last} ${EPITHETS[h[10]! % EPITHETS.length]}`, 40)
  const cry = cap(CRIES[h[14]! % CRIES.length]!(cryWord), 60)

  const strikes = lib.filter((m) => m.kind === 'strike')
  const own = strikes.filter((m) => m.school === school)
  const m0 = pick(own.length ? own : strikes, h, 2)
  const m1 = pick(lib.filter((m) => m.kind !== 'strike' && m.id !== m0.id), h, 4)
  const m2 = pick(lib.filter((m) => m.id !== m0.id && m.id !== m1.id), h, 6)
  const label = (m: RulebookMove, i: number) => {
    const verb = m.name.split(' ').pop() ?? 'Strike'
    const w = titleCase(ws[i % Math.max(ws.length, 1)] ?? 'Mystery')
    return cap(`${cap(w, 24 - verb.length - 1)} ${verb}`, 24)
  }
  const palette = PALETTE[school] ?? 'midnight navy and gold'
  const looks = [`A fight-poster portrait of ${sentence}, bold ink outlines, ${palette} palette.`, `A fight-poster portrait of ${sentence}, ${palette} palette.`, `A fight-poster portrait of ${sentence}.`]
  const look = cap(looks.find((l) => Array.from(l).length <= 160) ?? looks[2]!, 160)

  return {
    verdict: 'ok', name, title, look, cry, school, style: STYLES[h[12]! % STYLES.length],
    moves: [m0, m1, m2].map((m, i) => ({ id: m.id, label: label(m, i) })),
    weights: { power: 1 + (h[16]! % 10), guard: 1 + (h[17]! % 10), speed: 1 + (h[18]! % 10), grit: 1 + (h[19]! % 10) },
  }
}

/** The raw spec the stand-in compiler "returns" for a sentence: roster archetype first, else the deterministic build. */
export const standinRaw = (sim: Sim, sentence: string): RawSpec => rosterRaw(sentence) ?? buildRaw(sim, sentence)
