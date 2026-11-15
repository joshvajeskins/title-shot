// "My corner": record, earnings, belt ownership and payouts derived from contract views, and the loader's call budget.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawFight, RawPayout, RawSeason } from '../src/game/chain/views'
import { boutsOf, earningsOf, heldBeltIds, myPayouts, nearEarned, payoutTxHash, recordsOf, seasonPays, seasonsToRead, totalRecord } from '../src/game/corner/derive'
import { Rpc } from '../src/game/chain/rpc'
import { bustCorner, loadCorner } from '../src/game/corner/load'
import type { GameClient } from '../src/game/client'
import { belt as rawBelt, season as rawSeason } from './fixtures'
import { mapBelt } from '../src/game/chain/views'
import { sim } from './helpers'

const ME = 'judge.testnet'
const VANCE = 'vance.titleshot.testnet'
const E21 = 10n ** 21n
const FEE = 10n ** 22n // 0.01 NEAR forge fee

/** A fight view as get_fights returns it (only the fields the corner reads matter). */
function fight(id: number, o: Partial<RawFight> = {}): RawFight {
  return {
    id, challenge_id: id, belt_id: 1, season_id: 5, champion_hash: 'aa'.repeat(32), challenger_hash: 'bb'.repeat(32),
    holder: VANCE, challenger: ME, seed: '11'.repeat(32), seed_source: 'Block', rule: 2, winner: 'champion', winner_code: 0, state_hash: '22'.repeat(32),
    // bout #37 on testnet: 19.98 + 8.325 + 3.33 + 1.665 + storage 6.7 + fee 10 = 50 (milliNEAR)
    split: { champion: (19_980n * E21 / 1000n).toString(), promoter: (8_325n * E21 / 1000n).toString(), side_pot: (3_330n * E21 / 1000n).toString(), protocol: (1_665n * E21 / 1000n).toString() },
    storage: (6_700n * E21 / 1000n).toString(), at: String(BigInt(1_794_000_000_000 + id * 1000) * 1_000_000n), ...o,
  }
}
const season = (o: Partial<RawSeason>): RawSeason => rawSeason({ id: 5, state: 'Closed', payouts: [1], final_holder: VANCE, defence_count: [], side_pot: '0', ...o })
const fees = new Map([[1, FEE], [2, FEE], [3, FEE]])

describe('bouts and record', () => {
  const fights = [
    fight(33, { winner_code: 2, winner: 'draw' }), // challenger draw
    fight(36, { winner_code: 1, winner: 'challenger' }), // took the belt
    fight(37), // lost a title shot
    fight(40, { holder: ME, challenger: 'mara.testnet', champion_hash: 'bb'.repeat(32), challenger_hash: 'cc'.repeat(32) }), // defended
    fight(41, { holder: ME, challenger: 'otto.testnet', champion_hash: 'bb'.repeat(32), challenger_hash: 'dd'.repeat(32), winner_code: 2 }), // held draw
    fight(42, { holder: ME, challenger: 'otto.testnet', champion_hash: 'bb'.repeat(32), challenger_hash: 'dd'.repeat(32), winner_code: 1 }), // dethroned
    fight(50, { holder: VANCE, challenger: 'someone.testnet' }), // not mine
  ]
  const bouts = boutsOf([...fights, fight(37)], ME, fees) // a duplicate page row is counted once

  it('keeps only the account\'s bouts, newest first, with its side and outcome', () => {
    expect(bouts.map((b) => [b.id, b.role, b.outcome])).toEqual([
      [42, 'holder', 'dethroned'], [41, 'holder', 'draw'], [40, 'holder', 'defended'], [37, 'challenger', 'lost'], [36, 'challenger', 'took'], [33, 'challenger', 'draw'],
    ])
    expect(bouts[0]!.opponent).toBe('otto.testnet')
    expect(bouts[3]!.opponent).toBe(VANCE)
  })
  it('the toll is split + storage + forge fee, exactly 0.05 NEAR; only a held bout pays the account', () => {
    for (const b of bouts) expect(b.tollYocto).toBe(50n * E21)
    expect(bouts.find((b) => b.id === 37)!.receivedYocto).toBe(0n)
    expect(bouts.find((b) => b.id === 40)!.receivedYocto).toBe(19_980n * E21 / 1000n)
  })
  it('record per fighter: a held draw is a defence, losing the belt is not', () => {
    const r = recordsOf(bouts)
    expect(r.get('bb'.repeat(32))).toEqual({ w: 2, l: 2, d: 2, defences: 2, bouts: 6 })
    const other = recordsOf(boutsOf([fight(60, { challenger_hash: 'ee'.repeat(32), winner_code: 1 })], ME, fees))
    expect(totalRecord(new Map([...r, ...other]))).toEqual({ w: 3, l: 2, d: 2, defences: 2, bouts: 7 })
  })
  it('an account with no bouts has an empty record', () => {
    const none = boutsOf(fights, 'stranger.testnet', fees)
    expect(none).toEqual([])
    expect(totalRecord(recordsOf(none))).toEqual({ w: 0, l: 0, d: 0, defences: 0, bouts: 0 })
  })

  it('earnings: champion\'s share over held bouts, side-pots of seasons it closed holding, tolls paid as challenger', () => {
    const seasons = [
      { beltId: 1, season: season({ final_holder: ME, side_pot: (7n * E21).toString() }) },
      { beltId: 1, season: season({ final_holder: ME, side_pot: (7n * E21).toString() }) }, // read twice: counted once
      { beltId: 2, season: season({ id: 6, final_holder: VANCE, side_pot: (9n * E21).toString() }) },
      { beltId: 3, season: season({ id: 7, state: 'Open', final_holder: null, side_pot: (4n * E21).toString() }) },
    ]
    const e = earningsOf(bouts, seasons, ME)
    expect(e.championYocto).toBe(3n * 19_980n * E21 / 1000n)
    expect(e.championBouts).toBe(3)
    expect(e.sidePotYocto).toBe(7n * E21)
    expect(e.sidePotSeasons).toBe(1)
    expect(e.tollsPaidYocto).toBe(3n * 50n * E21)
    expect(e.challenges).toBe(3)
    expect(nearEarned(e)).toBe(e.championYocto + 7n * E21)
  })
})

describe('belts and seasons', () => {
  it('belt ownership comes from the NEP-171 token ids', () => {
    expect(heldBeltIds([{ token_id: 'belt-2', owner_id: ME }, { token_id: 'belt-3', owner_id: ME }, { token_id: 'junk', owner_id: ME }], ME)).toEqual([2, 3])
    expect(heldBeltIds([{ token_id: 'belt-1', owner_id: VANCE }], ME)).toEqual([])
    expect(heldBeltIds([], ME)).toEqual([])
  })
  it('reads each fought season once, plus the current season of a held belt', () => {
    const bouts = boutsOf([fight(1), fight(2), fight(3, { belt_id: 2, season_id: 6 })], ME, fees)
    expect(seasonsToRead(bouts, [{ beltId: 3, seasonId: 8 }, { beltId: 1, seasonId: 5 }]).sort((a, b) => a[0] - b[0])).toEqual([[1, 5], [2, 6], [3, 8]])
    expect(seasonsToRead([], [])).toEqual([])
  })
  it('only a closed season it held or defended in can owe it a payout', () => {
    expect(seasonPays(season({ final_holder: ME }), ME)).toBe(true)
    expect(seasonPays(season({ defence_count: [{ account: ME, defences: 1 }] }), ME)).toBe(true)
    expect(seasonPays(season({}), ME)).toBe(false)
    expect(seasonPays(season({ state: 'Open', final_holder: ME }), ME)).toBe(false)
    expect(seasonPays(season({ final_holder: ME, payouts: [] }), ME)).toBe(false)
  })
})

describe('purse shares', () => {
  // payout 27 on testnet: this raw tx mined on Base Sepolia as 0x2840f463…
  const RAW27 = '0x02f87283014a3480830f424083f4240082627094edc7423225a2afc44375cf36feffc4119b484d4987071a9f68f5400080c080a07af77de03c782643a1f6485a91c4fbdc72435388e21d8d8d16e3c14ee721ba71a0693be24ee06de09104b33effa5bf49387aa06836d230ca48c15fa20d456246be'
  const H27 = '0x2840f463d95d2a7103aa8ffeb992b6d7ece15b42c3649ec698de9dda2388e9b2'
  const p = (id: number, o: Partial<RawPayout>): RawPayout => ({ id, belt_id: 1, season_id: 5, payee: ME, amount_wei: '1500000000000000', to: '0x' + 'cd'.repeat(20), nonce: 0, signing: false, raw_tx: null, attempt: 0, value_wei: null, max_fee_per_gas: null, gas_limit: null, ...o })

  it('the Base tx hash of a signed payout is keccak256 of its raw bytes', () => {
    expect(payoutTxHash(RAW27)).toBe(H27)
    expect(payoutTxHash(null)).toBeNull()
    expect(payoutTxHash('0xzz')).toBeNull()
  })
  it('lists only the account\'s shares with an honest status', () => {
    const seasons = [{ beltId: 1, season: season({ final_holder: ME }) }]
    const rows = myPayouts([
      p(18, { to: null }), p(19, { payee: VANCE }), p(20, { raw_tx: RAW27 }), p(21, { signing: true }), p(22, {}), p(23, { raw_tx: RAW27.replace(/be$/, 'bf') }),
    ], seasons, ME, new Map([[H27, 'mined' as const]]))
    expect(rows.map((r) => [r.id, r.state])).toEqual([[23, 'signed'], [22, 'unsigned'], [21, 'signing'], [20, 'mined'], [18, 'claimable']])
    expect(rows.find((r) => r.id === 20)!.txHash).toBe(H27)
    expect(rows.every((r) => r.share === 'holder')).toBe(true)
  })
})

describe('loadCorner reads each belt once and filters per account', () => {
  afterEach(() => { vi.unstubAllGlobals(); bustCorner() })
  it('a stranger with no history costs one get_fights per belt plus three account reads', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      const m = body.params.method_name ?? body.method
      calls.push(m)
      const out = m === 'get_fights' ? [fight(1)] : m === 'nft_tokens_for_owner' ? [] : m === 'balance_of' ? '0' : null
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { result: [...new TextEncoder().encode(JSON.stringify(out))] } }))
    }))
    const rb = sim().rulebook()
    const belts = [1, 2, 3].map((id) => mapBelt(rawBelt({ id }), rb)!)
    const client = { mode: 'testnet', rpc: new Rpc({ urls: ['http://rpc.test'] }), contract: 'ring.testnet', belts: async () => belts, history: async () => [] } as unknown as GameClient
    const d = await loadCorner(client, 'nobody.testnet')
    expect(d.bouts).toEqual([])
    expect(d.fighters).toEqual([])
    expect(d.held).toEqual([])
    expect(d.payouts).toEqual([])
    expect(nearEarned(d.earnings)).toBe(0n)
    expect(calls.sort()).toEqual(['balance_of', 'get_evm_address', 'get_fights', 'get_fights', 'get_fights', 'nft_tokens_for_owner'])
    // a second account on the same page reuses the fights already read
    calls.length = 0
    await loadCorner(client, 'other.testnet')
    expect(calls.filter((c) => c === 'get_fights')).toEqual([])
  })
})
