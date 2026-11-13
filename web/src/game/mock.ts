// Local mock client: real roster and art, simulated chain. Used for UI work and as an offline demo mode.
import roster from './roster.json'
import { mockFight } from './mocksim'
import type { Account, Belt, Fight, Fighter, ForgeProgress, Odds, School, Spec, Style } from './types'
import { cleanSentence, type FightSummary, type GameClient, type PreviewResult } from './client'

type RosterRow = { sentence: string; portrait: string; raw: { name: string; title: string; look: string; cry: string; school: string; style: string; moves: { id: string; label: string }[]; weights: Record<string, number> } }
const ROSTER = roster as RosterRow[]
const NEAR = 10n ** 24n
const TOLL = (NEAR / 10n).toString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

function toSpec(raw: RosterRow['raw']): Spec {
  const w = raw.weights
  const tot = (w.power + w.guard + w.speed + w.grit) || 1
  const pts = 70
  const st = { power: Math.round((w.power / tot) * pts), guard: Math.round((w.guard / tot) * pts), speed: Math.round((w.speed / tot) * pts), grit: 0 }
  st.grit = pts - st.power - st.guard - st.speed
  return { name: raw.name, title: raw.title, look: raw.look, cry: raw.cry, school: raw.school as School, style: raw.style as Style, moves: raw.moves.map((m) => ({ id: m.id, label: m.label })), stats: st }
}

function fighterFrom(row: RosterRow, writer: string): Fighter {
  return { sentence: row.sentence, sentenceHash: hash(row.sentence).toString(16), spec: toSpec(row.raw), portrait: row.portrait, writer, record: { w: 0, l: 0, d: 0 } }
}

const SCHOOLS: [RegExp, School][] = [
  [/fire|flame|burn|hot|dragon|spicy|lava|toast|coffee|sun/i, 'BLAZE'],
  [/sea|ocean|wave|water|rain|fish|squid|kraken|duck|soup|tide/i, 'TIDE'],
  [/storm|thunder|electric|robot|laser|lightning|disco|wifi|battery|rocket/i, 'VOLT'],
  [/iron|steel|rock|mountain|knight|armou?r|machine|grandma|tank|wall/i, 'IRON'],
  [/ghost|wizard|lawyer|law|chess|brain|mind|psychic|library|tax|spreadsheet/i, 'MIND'],
]
function synth(sentence: string): Spec {
  const h = hash(sentence)
  const school = SCHOOLS.find(([re]) => re.test(sentence))?.[1] ?? 'WILD'
  const words = sentence.replace(/[^a-z0-9 ]/gi, '').split(' ').filter((w) => w.length > 3)
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase()
  const name = words.slice(-2).map(cap).join(' ') || 'The Contender'
  const styles: Style[] = ['BRAWLER', 'TACTICIAN', 'COUNTERPUNCHER', 'SHOWBOAT']
  const a = 10 + (h % 20), b = 10 + ((h >> 5) % 20), c = 10 + ((h >> 10) % 20)
  return {
    name, title: `The ${cap(words[0] ?? 'Unknown')} Threat`, look: sentence, cry: `${name} came to win!`, school, style: styles[h % 4],
    moves: [{ id: 'ember_jab', label: `${cap(words[0] ?? 'Wild')} Jab` }, { id: 'iron_fist', label: `${cap(words[1] ?? 'Big')} Slam` }, { id: 'second_wind', label: 'Second Wind' }],
    stats: { power: a, guard: b, speed: c, grit: 70 - a - b - c },
  }
}

export class MockClient implements GameClient {
  readonly mode = 'mock' as const
  private acct: Account | null = null
  private fights = new Map<string, Fight>()
  private beltsState: Belt[]

  constructor() {
    const now = Date.now()
    const pick = (s: string) => ROSTER.find((r) => r.sentence === s) ?? ROSTER[0]
    const mk = (id: string, name: string, art: string, accent: Belt['accent'], champ: string, writer: string, hours: number, rule: Belt['season']['rule'], purseWei: string): Belt => ({
      id, name, art, accent, champion: fighterFrom(pick(champ), writer), reignSince: now - 3.4 * 3600e3,
      defences: 7 + (hash(id) % 30), failedChallengers: 7 + (hash(id) % 30), writerEarnedYocto: ((NEAR * BigInt(3 + (hash(id) % 5))) / 2n).toString(), tollYocto: TOLL,
      season: { id: 3, startsAt: now - 5 * 3600e3, endsAt: now + hours * 3600e3, rule, purse: { chain: 'base-sepolia', address: '0x7a3f9c1e2b4d5a6f8e0c1b2a3d4e5f6a7b8c9d0e', amountWei: purseWei, symbol: 'ETH', explorer: 'https://sepolia.basescan.org/address/0x7a3f9c1e2b4d5a6f8e0c1b2a3d4e5f6a7b8c9d0e' }, sidePotYocto: (NEAR * 2n).toString(), challenges: 41 },
    })
    this.beltsState = [
      mk('midnight', 'The Midnight Belt', '/art/belt-midnight.webp', 'gold', 'a grandma who never stops knitting', 'velvet-vance.titleshot.testnet', 2.2, { id: 2, name: 'Padded Ring', desc: 'Stun chances are halved.' }, '4000000000000000'),
      mk('tide', 'The Tide Belt', '/art/belt-tide.webp', 'blue', 'a very polite kraken', 'mara-quill.testnet', 9.5, null, '2500000000000000'),
      mk('wildcard', 'The Wildcard Belt', '/art/belt-wildcard.webp', 'red', "the world's angriest goose", 'otto-ink.testnet', 0.4, { id: 6, name: 'Slow Burn', desc: 'Burn ticks deal double damage.' }, '1500000000000000'),
    ]
    this.beltsState[2].lastBell = {
      seasonId: 2, at: now - 26 * 3600e3, holder: 'otto-ink.testnet', holderName: 'Honk Vengeance', purseWei: '1500000000000000', sidePotYocto: '1350000000000000000000000',
      payouts: [
        { payee: 'otto-ink.testnet', name: 'Honk Vengeance', share: 'holder', amountWei: '937500000000000', status: 'signed' },
        { payee: 'mara-quill.testnet', name: 'Sir Squidley', share: 'defences', defences: 9, amountWei: '375000000000000', status: 'signed' },
        { payee: 'velvet-vance.titleshot.testnet', name: 'Granny Purl', share: 'defences', defences: 5, amountWei: '187500000000000', status: 'signed' },
      ],
    }
  }

  async account() {
    if (!this.acct) { try { const raw = localStorage.getItem('ts-mock-account'); if (raw) this.acct = JSON.parse(raw) as Account } catch { /* storage blocked */ } }
    return this.acct
  }
  async createGuest() {
    await sleep(900)
    this.acct = { id: `fighter-${(Date.now() % 1e6).toString(36)}.titleshot.testnet`, kind: 'guest', balanceYocto: (NEAR * 2n).toString(), claimableYocto: '0' }
    try { localStorage.setItem('ts-mock-account', JSON.stringify(this.acct)) } catch { /* storage blocked */ }
    return this.acct
  }
  async signOut() { this.acct = null; try { localStorage.removeItem('ts-mock-account') } catch { /* storage blocked */ } }
  async belts() { return this.beltsState }
  async belt(id: string) {
    const b = this.beltsState.find((x) => x.id === id)
    if (!b) throw new Error('belt not found')
    return b
  }
  async preview(sentence: string): Promise<PreviewResult> {
    await sleep(1400)
    const s = cleanSentence(sentence)
    const row = ROSTER.find((r) => r.sentence.toLowerCase() === s.toLowerCase())
    return row ? { spec: toSpec(row.raw), portrait: row.portrait, canonical: true } : { spec: synth(s), portrait: null, canonical: false }
  }
  odds(champion: Spec, challenger: Spec, rule: number, n = 120): Odds {
    let w = 0, d = 0
    for (let i = 0; i < n; i++) { const r = mockFight(champion, challenger, i * 7919 + 1, rule).winner; if (r === 1) w++; else if (r === 2) d++ }
    return { win: w / n, draw: d / n, loss: (n - w - d) / n, n }
  }
  async challenge(beltId: string, sentence: string, onProgress: (p: ForgeProgress) => void): Promise<Fight> {
    const belt = await this.belt(beltId)
    const pv = await this.preview(sentence)
    const fake = (n: number) => ({ label: '', tx: `mock${n}${Date.now().toString(36)}`, url: '#' })
    onProgress({ stage: 'toll', note: '0.1 NEAR toll paid from your balance', receipt: { ...fake(1), label: 'challenge' } })
    await sleep(1200); onProgress({ stage: 'tee', note: 'OutLayer TEE worker picked up the forge' })
    await sleep(2200); onProgress({ stage: 'compile', note: 'NEAR AI compiled your sentence (signed)' })
    await sleep(1600); onProgress({ stage: 'verify', note: 'Contract checked the AI signature and the budget' })
    await sleep(900)
    const seed = hash(sentence + Date.now())
    const { events, winner } = mockFight(belt.champion.spec, pv.spec, seed, belt.season.rule?.id ?? 0)
    const me = this.acct?.id ?? 'guest.titleshot.testnet'
    const challenger: Fighter = { sentence: cleanSentence(sentence), sentenceHash: hash(sentence).toString(16), spec: pv.spec, portrait: pv.portrait, writer: me, record: { w: 0, l: 0, d: 0 } }
    const fight: Fight = {
      id: `c${Date.now().toString(36)}`, beltId, champion: belt.champion, challenger, seed: seed.toString(16), rule: belt.season.rule ?? { id: 4, name: 'Glass Jaws', desc: 'Critical hits deal x2 instead of x3/2.' }, events, winner, stateHash: seed.toString(16).padStart(64, '0'),
      split: { champion: '54000000000000000000000', promoter: '22500000000000000000000', sidePot: '9000000000000000000000', protocol: '4500000000000000000000', forgeFee: '10000000000000000000000' },
      receipts: [{ label: 'challenge', tx: 'mock', url: '#' }], at: Date.now(),
    }
    this.fights.set(fight.id, fight)
    if (winner === 1) { belt.champion = challenger; belt.defences = 0; belt.reignSince = Date.now() } else { belt.defences++; belt.failedChallengers++ }
    onProgress({ stage: 'fight', note: 'Bout resolved on chain' })
    return fight
  }
  async fight(id: string) {
    const f = this.fights.get(id)
    if (!f) throw new Error('fight not found')
    return f
  }
  async history(): Promise<FightSummary[]> {
    return [...this.fights.values()].map((f) => ({ id: f.id, beltId: f.beltId, challenger: f.challenger.writer, challengerName: f.challenger.spec.name, champion: f.champion.writer, championName: f.champion.spec.name, winner: f.winner, at: f.at, tollYocto: TOLL }))
  }
}
