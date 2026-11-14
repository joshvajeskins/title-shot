import { describe, expect, it } from 'vitest'
import { belt, fighter, fightRow, season, payout, challenge, hashOf, NOW_MS, TOLL, FEE } from './fixtures'
import { sim } from './helpers'
import { championShare, mapBelt, mapFighter, mapFightSummary, mapSeason, mapSplit, portraitFor, sentenceHash, beltStyle, nsToMs } from '../src/game/chain/views'
import { mapBell, payoutStatus } from '../src/game/chain/bell'
import { describeChallenge, formatNear, messageFor, networkError } from '../src/game/chain/errors'
import { computeOdds } from '../src/game/chain/odds'
import { toUiSpec, toChainSpec } from '../src/sim'
import { GameError } from '../src/game/client'

const rb = sim().rulebook()

describe('contract views map to the UI types', () => {
  it('a belt becomes the UI Belt (champion, reign, season, toll, art)', () => {
    const b = mapBelt(belt(), rb)!
    expect(b.id).toBe('1')
    expect(b.name).toBe('The Midnight Belt')
    expect(b.accent).toBe('gold')
    expect(b.art).toBe('/art/belt-midnight.webp')
    expect(b.tollYocto).toBe(TOLL)
    expect(b.champion.spec.moves).toHaveLength(3)
    expect(b.champion.spec.moves[0]!.id).toMatch(/^[a-z_]+$/)
    expect(b.champion.portrait).toBe('/art/fighter-pigeon.webp') // curated art for the seeded sentence
    expect(b.reignSince).toBe(NOW_MS - 7_200_000)
    expect(b.season.endsAt).toBe(NOW_MS + 3_600_000)
    expect(b.season.rule).toBeNull() // sealed until the first bout
    expect(b.season.purse.explorer).toContain('sepolia.basescan.org/address/0x')
    expect(b.seasonState).toBe('Open')
  })
  it('a revealed rule maps to its name', () => {
    const b = mapBelt(belt({ season: season({ sealed: false, rule: 2 }) }), rb)!
    expect(b.season.rule).toEqual({ id: 2, name: rb.rules[2]!.name, desc: rb.rules[2]!.desc })
  })
  it('a belt without a champion is hidden, a belt without a season still maps', () => {
    expect(mapBelt(belt({ champion: null }), rb)).toBeNull()
    const s = mapSeason(null, rb)
    expect(s.id).toBe(0)
    expect(s.purse.address).toBe('')
  })
  it('generated portraits point at /api/portrait/<hash>', () => {
    const f = fighter(5)
    const hashed = mapFighter({ ...f, sentence: 'my own brand new sentence', hash: hashOf('my own brand new sentence') })
    expect(hashed.portrait).toBe(`/api/portrait/${hashOf('my own brand new sentence')}`)
    expect(portraitFor('a pigeon with a law degree', 'x')).toBe('/art/fighter-pigeon.webp')
    expect(portraitFor('  A   Pigeon with a LAW degree ', 'x')).toBe('/art/fighter-pigeon.webp')
  })
  it('the sentence hash is sha256 of the cleaned sentence', () => {
    expect(sentenceHash('a   pigeon  ')).toBe(sentenceHash('a pigeon'))
    expect(sentenceHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('belt styles fall back by id for unknown names', () => {
    expect(beltStyle('Mystery Belt', 2).accent).toBe('blue')
    expect(beltStyle('Mystery Belt', 7).art).toMatch(/belt-/)
  })
  it('the writer-earned estimate is the champion share times defences, only for the champion writer', () => {
    expect(championShare(10n ** 23n, 10n ** 22n)).toBe(468n * 10n ** 20n) // (0.1 - 0.01 - 0.012 storage estimate) x 60%
    expect(mapBelt(belt({ holder: 'otto-ink.testnet', defences: 3 }), rb)!.writerEarnedYocto).toBe((championShare(BigInt(TOLL), BigInt(FEE)) * 3n).toString())
    expect(mapBelt(belt({ holder: 'someone.testnet' }), rb)!.writerEarnedYocto).toBe('0')
  })
  it('fight summaries carry the winner code, names and times in ms', () => {
    const f = fightRow(3)
    const sum = mapFightSummary(f, { champion: 'Counselor Coo', challenger: 'Granny Purl' }, TOLL)
    expect(sum).toMatchObject({ id: '3', beltId: '1', winner: f.winner_code, championName: 'Counselor Coo', tollYocto: TOLL })
    expect(sum.at).toBe(nsToMs(f.at))
    expect(mapSplit(f.split, FEE).forgeFee).toBe(FEE)
    expect(mapSplit(f.split, FEE, '7').storage).toBe('7')
  })
  it('spec conversion round trips and keeps library move ids', () => {
    const f = fighter(2)
    expect(toChainSpec(toUiSpec(f.spec))).toEqual(f.spec)
    const lib = new Set(rb.library.map((m) => m.id))
    for (const m of toUiSpec(f.spec).moves) expect(lib.has(m.id)).toBe(true)
  })
})

describe('the bell cinematic data', () => {
  const closed = season({ state: 'Closed', final_holder: 'otto-ink.testnet', payouts: [1, 2, 3], defence_count: [{ account: 'otto-ink.testnet', defences: 2 }, { account: 'mara-quill.testnet', defences: 5 }] })
  const list = [payout(1), payout(2, { payee: 'mara-quill.testnet', raw_tx: '0x02aa', nonce: 0 }), payout(3, { payee: 'nobody.testnet', to: null })]
  it('only a closed season has a bell', () => expect(mapBell(season(), list, new Map(), 'vance.titleshot.testnet')).toBeNull())
  it('rows carry share, defences and a UI status', () => {
    const tracks = new Map([[2, { hash: '0xfeed', status: 'mined' as const }]])
    const bell = mapBell(closed, list, tracks, 'vance.titleshot.testnet')!
    expect(bell.seasonId).toBe(2)
    expect(bell.holder).toBe('otto-ink.testnet')
    expect(bell.holderName).toBe('otto-ink')
    expect(bell.payouts.map((p) => [p.share, p.status])).toEqual([['holder', 'unsigned'], ['defences', 'mined'], ['defences', 'unclaimed']])
    expect(bell.payouts[1]).toMatchObject({ defences: 5, tx: '0xfeed' })
    expect(bell.payouts[1]!.explorer).toContain('sepolia.basescan.org/tx/0xfeed')
    // the unclaimed row keeps its payout id so its payee can claim it (claim_payout) from the bell screen
    expect(bell.payouts[2]!.id).toBe(list[2]!.id)
    expect(bell.payouts.every((p, i) => p.id === list[i]!.id)).toBe(true)
  })
  it('a season with no bouts marks the promoter row as a refund', () => {
    const bell = mapBell(season({ state: 'Closed', bouts: 0, final_holder: 'vance.titleshot.testnet' }), [payout(9, { payee: 'vance.titleshot.testnet' })], new Map(), 'vance.titleshot.testnet')!
    expect(bell.payouts[0]!.share).toBe('holder') // the promoter is also the final holder
    const refund = mapBell(season({ state: 'Closed', bouts: 0, final_holder: 'someone.testnet' }), [payout(9, { payee: 'vance.titleshot.testnet' })], new Map(), 'vance.titleshot.testnet')!
    expect(refund.payouts[0]!.share).toBe('refund')
  })
  it('payout status follows the chain: claimable, unsigned, signing, signed, tracked', () => {
    expect(payoutStatus(payout(1, { to: null }), null)).toBe('claimable')
    expect(payoutStatus(payout(1), null)).toBe('unsigned')
    expect(payoutStatus(payout(1, { signing: true }), null)).toBe('signing')
    expect(payoutStatus(payout(1, { raw_tx: '0x02' }), null)).toBe('signed')
    expect(payoutStatus(payout(1, { raw_tx: '0x02' }), { hash: '0x1', status: 'sent' })).toBe('sent')
    expect(payoutStatus(payout(1, { raw_tx: '0x02' }), { hash: '0x1', status: 'reverted' })).toBe('reverted')
  })
})

describe('contract errors become sentences, challenge views become progress', () => {
  it('E_BALANCE says how much to top up', () => expect(messageFor('E_BALANCE', { toll: 10n ** 23n, balance: 4n * 10n ** 22n })).toBe('Top up: you need 0.1 NEAR for the toll and have 0.04.'))
  it('every documented code has a human message', () => {
    for (const c of ['E_PENDING', 'E_SELF', 'E_SAME_SENTENCE', 'E_SENTENCE', 'E_NO_SEASON', 'E_NO_CHAMPION', 'E_STORAGE', 'E_AI_SIG', 'E_REFUSED', 'E_FORGE_FAILED', 'E_TIMEOUT', 'E_UNKNOWN_MOVE', 'E_DUP_MOVE', 'E_BAD_STATS', 'E_STATE']) {
      expect(messageFor(c), c).not.toMatch(/^The contract refused/)
    }
    expect(messageFor('E_SOMETHING_NEW')).toBe('The contract refused: E_SOMETHING_NEW.')
    expect(messageFor(null)).toMatch(/Something went wrong/)
  })
  it('formats NEAR amounts without float errors', () => { expect(formatNear(10n ** 23n)).toBe('0.1'); expect(formatNear(0n)).toBe('0'); expect(formatNear(1_234_000_000_000_000_000_000_000n, 3)).toBe('1.234'); expect(formatNear(3n * 10n ** 24n)).toBe('3') })
  it('Forging -> forging, Resolved -> fight id, Rejected and Refunded -> failed with the code', () => {
    expect(describeChallenge(challenge())).toEqual({ phase: 'forging' })
    expect(describeChallenge(null)).toEqual({ phase: 'forging' })
    expect(describeChallenge(challenge({ status: 'Resolved', fight_id: 9 }))).toEqual({ phase: 'resolved', fightId: 9 })
    const rej = describeChallenge(challenge({ status: 'Rejected', code: 'E_REFUSED', detail: 'verdict refused' }))
    expect(rej).toMatchObject({ phase: 'failed', code: 'E_REFUSED', refunded: true })
    expect(describeChallenge(challenge({ status: 'Refunded', code: 'E_FORGE_FAILED' }))).toMatchObject({ phase: 'failed', code: 'E_FORGE_FAILED' })
    expect(describeChallenge(challenge({ status: 'Refunded', code: null }))).toMatchObject({ phase: 'failed', code: 'E_FORGE_FAILED' })
  })
  it('network errors keep their GameError and turn timeouts into a friendly sentence', () => {
    const g = new GameError('E_X', 'x')
    expect(networkError(g)).toBe(g)
    expect(networkError(new Error('Request timeout on the free plan')).message).toMatch(/slow/)
    expect(networkError('boom').code).toBe('E_NETWORK')
  })
})

describe('odds from the wasm', () => {
  const champ = toUiSpec(fighter(0).spec), chall = toUiSpec(fighter(1).spec)
  it('fractions sum to one and are deterministic', () => {
    const a = computeOdds(sim(), champ, chall, 2, 100)
    const b = computeOdds(sim(), champ, chall, 2, 100)
    expect(a).toEqual(b)
    expect(a.win + a.draw + a.loss).toBeCloseTo(1, 5)
    expect(a.n).toBe(100)
  })
  it('a sealed rule (255) averages over all eight arena rules', () => {
    const o = computeOdds(sim(), champ, chall, 255, 200)
    expect(o.n).toBe(200)
    expect(o.win + o.draw + o.loss).toBeCloseTo(1, 5)
  })
  it('a fighter against itself is near even', () => {
    const o = computeOdds(sim(), champ, champ, 255, 400)
    expect(Math.abs(o.win - o.loss)).toBeLessThan(0.2)
  })
})
