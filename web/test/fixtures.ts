// Contract-view fixtures built from the real wasm (normalize + simulate), in the shapes contract/src/views.rs emits.
import { sha256 } from '@noble/hashes/sha2.js'
import { archetypes, sim } from './helpers'
import { toHex, utf8 } from '../src/game/chain/bytes'
import { cleanSentence } from '../src/game/client'
import type { RawBelt, RawChallenge, RawFight, RawFighter, RawPayout, RawSeason } from '../src/game/chain/views'
import type { ChainSpec } from '../src/sim'

export const CONTRACT = 'titleshot.testnet'
export const NEAR = 10n ** 24n
export const TOLL = (NEAR / 10n).toString()
export const FEE = (NEAR / 100n).toString()
export const NOW_MS = 1_800_000_000_000
export const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString()

export const hashOf = (sentence: string) => toHex(sha256(utf8(cleanSentence(sentence))))

export function fighter(index: number, writer = 'otto-ink.testnet'): RawFighter {
  const a = archetypes()[index]!
  const n = sim().normalize(JSON.stringify(a.raw))
  if (!n.ok) throw new Error('fixture does not normalize')
  return { hash: hashOf(a.sentence), sentence: a.sentence, spec: n.spec as ChainSpec, writer, forged_at: ns(NOW_MS - 3_600_000), signer: '0x937585ec9249545782df2b2ffd0f0693cc4abf43', record: { wins: 2, losses: 1, draws: 0 } }
}

export function season(over: Partial<RawSeason> = {}): RawSeason {
  return {
    id: 2, state: 'Open', duration_sec: 21600, opens_at: ns(NOW_MS - 3_600_000), closes_at: ns(NOW_MS + 3_600_000), rule: null, sealed: true, side_pot: (NEAR / 4n).toString(),
    bouts: 3, challenges: 3, pending: 0, purse: { chain_id: 84532, path: 'belt-1-s2', amount_wei: '2000000000000000', address: '0x' + 'ab'.repeat(20), next_nonce: 0 },
    defence_count: [{ account: 'otto-ink.testnet', defences: 2 }], payouts: [], final_holder: null, ...over,
  }
}

export function belt(over: Partial<RawBelt> = {}): RawBelt {
  return {
    id: 1, name: 'The Midnight Belt', token_id: 'belt-1', promoter: 'vance.titleshot.testnet', holder: 'otto-ink.testnet', toll: TOLL, forge_fee: FEE, purse_chain_id: 84532,
    media: '', season: season(), champion: fighter(0), reign_since: ns(NOW_MS - 7_200_000), defences: 2, fights: 3, top_defenders: [], ...over,
  }
}

export function fightRow(id = 1, champ = 0, chall = 1, over: Partial<RawFight> = {}): RawFight {
  const s = sim()
  const c = fighter(champ), h = fighter(chall, 'mara-quill.testnet')
  const seed = '11'.repeat(32)
  const r = s.simulate(c.spec, h.spec, seed, 2)
  if (!r.ok) throw new Error('sim failed')
  const winner = r.fight.winner
  return {
    id, challenge_id: 5, belt_id: 1, season_id: 2, champion_hash: c.hash, challenger_hash: h.hash, holder: 'otto-ink.testnet', challenger: 'mara-quill.testnet', seed, seed_source: 'Vrf', rule: 2,
    winner: ['champion', 'challenger', 'draw'][winner]!, winner_code: winner, state_hash: r.fight.state_hash,
    split: { champion: '54000000000000000000000', promoter: '22500000000000000000000', side_pot: '9000000000000000000000', protocol: '4500000000000000000000' }, at: ns(NOW_MS - 60_000), ...over,
  }
}

export function challenge(over: Partial<RawChallenge> = {}): RawChallenge {
  const f = fighter(1, 'mara-quill.testnet')
  return { id: 5, belt_id: 1, season_id: 2, challenger: 'mara-quill.testnet', sentence: f.sentence, hash: f.hash, status: 'Forging', code: null, detail: null, fight_id: null, created_at: ns(NOW_MS), need_compile: true, kind: 'Challenge', toll: TOLL, fee: FEE, relayer: false, ...over }
}

export function payout(id: number, over: Partial<RawPayout> = {}): RawPayout {
  return { id, belt_id: 1, season_id: 2, payee: 'otto-ink.testnet', amount_wei: '1000000000000000', to: '0x' + 'cd'.repeat(20), nonce: null, signing: false, raw_tx: null, attempt: 0, value_wei: null, max_fee_per_gas: null, gas_limit: null, ...over }
}
