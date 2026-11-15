// "My corner" reads. Every belt's fights are read once (get_fights pages of 50) and cached for the page, then filtered per
// account; fighters are cached by hash (a forged spec never changes). Only the seasons this account fought in are read, and
// only the payouts of seasons that could owe it one. Base receipts are asked only for this account's signed payouts.
import { GameError, type FightSummary, type GameClient } from '../client'
import type { Fighter } from '../types'
import { Rpc } from '../chain/rpc'
import { BASE_SEPOLIA_RPCS } from '../chain/basenames'
import { networkError } from '../chain/errors'
import { readPayoutAddress } from '../chain/payout'
import { mapFighter, type ChainBelt, type RawFight, type RawFighter, type RawPayout, type RawSeason } from '../chain/views'
import {
  boutsOf, earningsOf, fighterOrder, heldBeltIds, myPayouts, payoutTxHash, recordsOf, seasonPays, seasonsToRead,
  type BoutRow, type Earnings, type FighterRecord, type MyPayout, type ReceiptStatus, type SeasonRead,
} from './derive'

export interface CornerSource { rpc: Rpc; contract: string }

/** The live chain behind a client, or null for the offline demo (it has no contract to read). */
export function cornerSource(client: GameClient): CornerSource | null {
  const c = client as GameClient & Partial<CornerSource>
  return client.mode === 'testnet' && c.rpc instanceof Rpc && typeof c.contract === 'string' ? { rpc: c.rpc, contract: c.contract } : null
}

export interface CornerFighter { fighter: Fighter; record: FighterRecord; wroteIt: boolean; holds: ChainBelt[] }
export interface CornerBout extends BoutRow { beltName: string; myName: string; oppName: string }
export interface CornerData {
  account: string; at: number
  balanceYocto: bigint; payoutAddress: string | null
  held: ChainBelt[]; belts: ChainBelt[]
  fighters: CornerFighter[]; bouts: CornerBout[]
  earnings: Earnings; payouts: MyPayout[]
}

const TTL = 20_000
const memo = new Map<string, { at: number; p: Promise<unknown> }>()
function cached<T>(key: string, fn: () => Promise<T>, ttl = TTL): Promise<T> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.p as Promise<T>
  const p = fn()
  memo.set(key, { at: Date.now(), p })
  p.catch(() => { if (memo.get(key)?.p === p) memo.delete(key) })
  return p
}
const fighters = new Map<string, Promise<RawFighter | null>>()

/** Drop the cached reads (Retry, or after a claim): fighters stay, they are immutable. */
export function bustCorner(): void { memo.clear() }

const view = <T>(src: CornerSource, method: string, args: unknown): Promise<T> =>
  src.rpc.view<T>(src.contract, method, args).catch((e) => { throw networkError(e) })

/** Every fight of one belt, newest first, in pages of 50 (the contract's cap). */
async function beltFights(src: CornerSource, beltId: number): Promise<RawFight[]> {
  const out: RawFight[] = []
  for (let from = 0; from < 10_000; from += 50) {
    const page = await view<RawFight[]>(src, 'get_fights', { belt_id: beltId, from, limit: 50 })
    out.push(...page)
    if (page.length < 50) break
  }
  return out
}

/** All fights on all belts: three calls today, shared by every account the page shows. */
export const allFights = (src: CornerSource, beltIds: number[]): Promise<RawFight[]> =>
  cached(`fights:${beltIds.join(',')}`, async () => (await Promise.all(beltIds.map((id) => beltFights(src, id)))).flat())

function fighter(src: CornerSource, hash: string): Promise<RawFighter | null> {
  let p = fighters.get(hash)
  if (!p) { p = view<RawFighter | null>(src, 'get_fighter', { hash_hex: hash }); fighters.set(hash, p); p.catch(() => fighters.delete(hash)) }
  return p
}

const baseRpc = new Rpc({ urls: BASE_SEPOLIA_RPCS, timeoutMs: 8000 })
async function receipt(hash: string): Promise<ReceiptStatus> {
  const r = await baseRpc.call<{ status?: string } | null>('eth_getTransactionReceipt', [hash]).catch(() => null)
  return r?.status === '0x1' ? 'mined' : r?.status === '0x0' ? 'reverted' : null
}

export async function loadCorner(client: GameClient, account: string): Promise<CornerData> {
  const src = cornerSource(client)
  if (!src) throw new GameError('E_OFFLINE', 'My corner reads the NEAR contract. This offline demo has no chain to read.')
  const belts = (await client.belts()) as ChainBelt[]
  const beltById = new Map(belts.map((b) => [b.numericId, b]))
  const [fights, tokens, balance, payoutAddress, summaries] = await Promise.all([
    allFights(src, belts.map((b) => b.numericId)),
    cached(`nft:${account}`, () => view<{ token_id: string; owner_id: string }[]>(src, 'nft_tokens_for_owner', { account_id: account, from_index: null, limit: 50 })),
    cached(`bal:${account}`, () => view<string>(src, 'balance_of', { account }), 5000),
    cached(`evm:${account}`, () => readPayoutAddress(src.rpc, src.contract, account)),
    client.history().catch((): FightSummary[] => []),
  ])
  const held = heldBeltIds(tokens, account).map((id) => beltById.get(id)).filter((b): b is ChainBelt => !!b)
  const bouts = boutsOf(fights, account, new Map(belts.map((b) => [b.numericId, BigInt(b.forgeFeeYocto)])))

  // two independent chains of reads, run side by side: the seasons that could have paid this account (then their payouts and
  // Base receipts), and the fighters on both sides of its bouts
  const pairs = seasonsToRead(bouts, held.map((b) => ({ beltId: b.numericId, seasonId: b.season.id })))
  const money = (async () => {
    const seasons: SeasonRead[] = (await Promise.all(pairs.map(async ([beltId, id]) => {
      const season = await cached(`season:${beltId}:${id}`, () => view<RawSeason | null>(src, 'get_season', { belt_id: beltId, season_id: id }))
      return season ? { beltId, season } : null
    }))).filter((s): s is SeasonRead => !!s)
    const rawPayouts = (await Promise.all(seasons.filter((s) => seasonPays(s.season, account)).map((s) =>
      cached(`payouts:${s.beltId}:${s.season.id}`, () => view<RawPayout[]>(src, 'get_payouts', { belt: s.beltId, season: s.season.id }))))).flat()
    const mine = rawPayouts.filter((p) => p.payee === account)
    const receipts = new Map<string, ReceiptStatus>()
    await Promise.all(mine.map(async (p) => {
      const h = payoutTxHash(p.raw_tx)
      if (h) receipts.set(h, await cached(`rcpt:${h}`, () => receipt(h), 60_000))
    }))
    return { seasons, mine, receipts }
  })()

  // names: the state's recent fights carry them; any other fighter is read once by hash
  const names = new Map<string, string>()
  const byId = new Map(summaries.map((s) => [Number(s.id), s]))
  for (const b of bouts) {
    const s = byId.get(b.id)
    if (!s) continue
    names.set(b.role === 'challenger' ? b.oppHash : b.myHash, s.championName)
    names.set(b.role === 'challenger' ? b.myHash : b.oppHash, s.challengerName)
  }
  const order = fighterOrder(bouts)
  const mineRaw = new Map<string, RawFighter>()
  const opp = [...new Set(bouts.map((b) => b.oppHash))].filter((h) => !names.has(h) && !order.includes(h))
  await Promise.all([
    ...order.map(async (h) => { const f = await fighter(src, h); if (f) { mineRaw.set(h, f); names.set(h, f.spec.name) } }),
    ...opp.map(async (h) => { const f = await fighter(src, h); names.set(h, f?.spec.name ?? 'Unknown') }),
  ])
  const { seasons, mine, receipts } = await money

  const records = recordsOf(bouts)
  const cornerFighters: CornerFighter[] = order.flatMap((h) => {
    const raw = mineRaw.get(h)
    if (!raw) return []
    return [{ fighter: mapFighter(raw), record: records.get(h)!, wroteIt: raw.writer === account, holds: held.filter((b) => b.champion.sentenceHash === h) }]
  })
  return {
    account, at: Date.now(), balanceYocto: BigInt(String(balance)), payoutAddress, held, belts,
    fighters: cornerFighters,
    bouts: bouts.map((b) => ({ ...b, beltName: beltById.get(b.beltId)?.name ?? `Belt ${b.beltId}`, myName: names.get(b.myHash) ?? 'Unknown', oppName: names.get(b.oppHash) ?? 'Unknown' })),
    earnings: earningsOf(bouts, seasons, account), payouts: myPayouts(mine, seasons, account, receipts),
  }
}
