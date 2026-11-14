// The house challengers' personas and their sentence writer (docs/LIVENESS.md). NEAR AI writes each new fighter through the
// spend ledger exactly like Vance's openers (the tick's own spend: never past the key's hard stop); a curated list per NPC is
// the fallback.
import type { Env } from './env'
import { ApiError } from './http'
import { Ledger, type LedgerDeps } from './ledger'
import { chatText } from './nearai'
import { openerOk, tidyOpener } from './opener'
import type { Usage } from './pricing'

export interface HouseNpc {
  key: 'a' | 'b'
  /** default account id (env HOUSE_A_ID / HOUSE_B_ID override it) */
  id: string
  /** persona shown in the UI */
  name: string
  bio: string
  /** what kind of fighter this NPC brings (steers the prompt) */
  taste: string
  /** curated sentences, used when NEAR AI is unavailable */
  fallback: readonly string[]
}

export const HOUSE_NPCS: readonly HouseNpc[] = [
  {
    key: 'a',
    id: 'house-a.titleshot.testnet',
    name: 'Mother Ruckus',
    bio: 'Runs the boiler-room gym under the arena and enters whoever is warming up on her bench.',
    taste: 'big, loud, physical fighters with ordinary jobs, kitchens and building sites',
    fallback: [
      'a dinner lady who swings a soup ladle like a mace',
      'a night-shift baker with forearms like bread loaves',
      'a removal man who carries pianos upstairs for fun',
      'a lifeguard who has never once left her chair',
      'a tow truck driver who arm-wrestles the trucks',
      'a bricklayer who builds a wall mid-fight and hides behind it',
    ],
  },
  {
    key: 'b',
    id: 'house-b.titleshot.testnet',
    name: 'Professor Quill',
    bio: 'A retired chess hustler who scouts fighters at bus stops and always bets on the strange ones.',
    taste: 'small, odd, clever creatures and objects with one surprising skill',
    fallback: [
      'a chess clock that hits back when you take too long',
      'a library mouse who memorised every karate manual',
      'a pocket calculator with a grudge against fractions',
      'a snail who has never lost a race on paper',
      'a crossword puzzle that finishes you first',
      'a houseplant that learned boxing from the television',
    ],
  },
]

/** What the UI may show about the house NPCs (no keys, no internals). */
export const HOUSE_PERSONAS = HOUSE_NPCS.map(({ key, id, name, bio }) => ({ key, id, name, bio }))

const SYSTEM = 'You write one-line fighter descriptions for a comedy arena game. Reply with ONLY the description: 5 to 14 words, lowercase, no quotes, no names of real people, brands or copyrighted characters, nothing hateful or sexual. Make it specific, visual and funny.'

export interface Written { sentence: string | null; closed: boolean }

/**
 * One fresh challenger sentence in this NPC's taste. `closed` = the ledger refused the call (hard stop reached or KV
 * unhealthy): the caller must not count on a compile either. `sentence: null, closed: false` = NEAR AI failed or wrote
 * something unusable (or there is no NEAR AI key): a curated fallback will do.
 */
export async function writeHouseSentence(env: Env, model: string, npc: HouseNpc, champion: string, avoid: string[], fetchFn: typeof fetch = fetch, ledgerDeps: LedgerDeps = {}): Promise<Written> {
  const ledger = Ledger.of(env, { fetchFn, ...ledgerDeps })
  if (!ledger) return { sentence: null, closed: false }
  const hold = await ledger.reserve('opener', model, 'tick').catch(() => null)
  if (!hold) return { sentence: null, closed: true }
  const seen: { answered: boolean; usage: Usage | null } = { answered: false, usage: null }
  try {
    const recent = avoid.slice(-6).join('; ') || 'nothing yet'
    const user = `You are ${npc.name}: ${npc.bio} Send in a challenger for the reigning champion "${champion}". Your taste: ${npc.taste}. Not similar to: ${recent}.`
    const raw = await chatText(env, model, SYSTEM, user, fetchFn, (u) => { seen.answered = true; seen.usage = u })
    await ledger.settle(hold, seen.usage ?? 'worst')
    const s = tidyOpener(raw)
    const used = new Set([champion, ...avoid].map((x) => x.toLowerCase()))
    return { sentence: openerOk(s) && !used.has(s.toLowerCase()) ? s : null, closed: false }
  } catch (e) {
    await ledger.settle(hold, seen.answered ? seen.usage ?? 'worst' : e instanceof ApiError && e.code === 'AI_STATUS' ? 'free' : 'worst')
    return { sentence: null, closed: false }
  }
}
