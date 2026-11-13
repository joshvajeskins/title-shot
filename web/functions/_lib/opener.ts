// Vance's opener sentences: NEAR AI writes one short, funny fighter sentence per season; a curated list is the fallback.
import { sentenceProblem, cleanSentence } from '../../src/game/client'
import type { Env } from './env'
import { chatText } from './nearai'

export const FALLBACK_OPENERS = [
  'a lighthouse keeper who bench-presses the lighthouse',
  'a retired circus bear with a law degree',
  'the angriest barista in the city',
  'a ghost who is very bad at haunting',
  'a medieval knight stuck in a self-checkout lane',
  'an opera-singing walrus in a tuxedo',
  'a cactus that survived three divorces',
  'a pirate accountant who only accepts doubloons',
  'a sentient vending machine with trust issues',
  'a tiny dragon who runs a bakery',
]

const SYSTEM = 'You write one-line fighter descriptions for a comedy arena game. Reply with ONLY the description: 5 to 14 words, lowercase, no quotes, no names of real people, brands or copyrighted characters, nothing hateful or sexual. Make it specific, visual and funny.'

/** Clean model chatter into a candidate sentence (first line, no quotes or trailing punctuation). */
export function tidyOpener(raw: string): string {
  const first = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return cleanSentence(first.replace(/^["'`“”‘’\-*\d.\s]+/, '').replace(/["'`“”‘’.]+$/, ''))
}

export const openerOk = (s: string): boolean => sentenceProblem(s) === null && s.split(' ').length >= 3 && s.length <= 100

export interface OpenerCtx { seasonId: number; recent: string[] }

export async function writeOpener(env: Env, model: string, ctx: OpenerCtx, fetchFn: typeof fetch = fetch): Promise<{ sentence: string; source: 'nearai' | 'fallback' }> {
  const used = new Set(ctx.recent.map((s) => s.toLowerCase()))
  if (env.NEARAI_API_KEY) {
    try {
      const avoid = ctx.recent.slice(-6).join('; ')
      const raw = await chatText(env, model, SYSTEM, `Season ${ctx.seasonId}. Write a fresh fighter that is not similar to: ${avoid || 'nothing yet'}.`, fetchFn)
      const s = tidyOpener(raw)
      if (openerOk(s) && !used.has(s.toLowerCase())) return { sentence: s, source: 'nearai' }
    } catch { /* fall through to the curated list */ }
  }
  const pool = FALLBACK_OPENERS.filter((s) => !used.has(s.toLowerCase()))
  const list = pool.length ? pool : FALLBACK_OPENERS
  return { sentence: list[ctx.seasonId % list.length]!, source: 'fallback' }
}
