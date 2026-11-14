// GET /api/state: belts, recent fights, promoter wallets and the bell's payouts in one JSON.
import { mapBelt, mapFightSummary, type ChainBelt, type RawBelt, type RawFight } from '../../src/game/chain/views'
import { mapBell, payoutStatus, type PayoutStatus, type PayoutTrackLite } from '../../src/game/chain/bell'
import type { FightSummary } from '../../src/game/client'
import type { Rpc } from '../../src/game/chain/rpc'
import type { Sim } from '../../src/sim'
import { baseAddrUrl, baseTxUrl } from '../../src/game/chain/config'
import { utf8 } from '../../src/game/chain/bytes'
import { sha256Hex } from '../../src/game/chain/signature'
import { cachedJson, getJson } from './cache'
import { Chain, type ContractConfig } from './chain'
import { deriveEvmAddress, getBalance } from './evm'
import { DEFAULTS, type Env } from './env'
import { VANCE_PATH } from './purse'
import { compilerOf } from './standin'
import { trackKey } from './tickPayouts'
import { publicTick, type PayoutTrack, type TickLog } from './tickTypes'

export interface Wallet { account: string; role: 'sponsor' | 'promoter' | 'relayer'; nearYocto: string; baseAddress?: string; baseWei?: string }
export interface PayoutState {
  id: number; beltId: number; seasonId: number; payee: string; amountWei: string; to: string | null; nonce: number | null
  status: PayoutStatus; txHash?: string; explorer?: string
}
export interface StateResponse {
  at: number; contract: string; forgeMode: string; model: string
  /** which referee compiles sentences: 'nearai' (attested TEE model) or 'standin' (staging stand-in, label it as such in the UI) */
  compiler: 'nearai' | 'standin'
  /** hash of the rulebook in the bout-sim wasm shipped with this site (the contract has no rulebook hash of its own) */
  rulebookHash: string
  /** false = the wasm's request prefix/suffix differ from the ones stored in the contract (sha256 compared), so replays and previews would not match the paid forge */
  rulebookMatch: boolean
  belts: ChainBelt[]; fights: FightSummary[]; payouts: PayoutState[]; wallets: Wallet[]; tick: TickLog | null
}

type Tracks = Map<number, PayoutTrackLite | null>

/** The request the contract rebuilds for NEAR AI (prefix ‖ sentence ‖ suffix) is the one this site's wasm builds. */
export function requestMatches(sim: Sim, cfg: Pick<ContractConfig, 'model_id' | 'prefix_sha256' | 'suffix_sha256'>): boolean {
  try {
    const { prefix, suffix } = sim.requestParts(cfg.model_id)
    return sha256Hex(utf8(prefix)) === String(cfg.prefix_sha256).toLowerCase() && sha256Hex(utf8(suffix)) === String(cfg.suffix_sha256).toLowerCase()
  } catch { return false }
}

async function wallets(env: Env, near: Rpc, base: Rpc): Promise<Wallet[]> {
  const mpc = env.MPC_SIGNER ?? DEFAULTS.mpcSigner
  const ids: [Wallet['role'], string][] = [['sponsor', env.SPONSOR_ID ?? DEFAULTS.sponsorId], ['promoter', env.VANCE_ID ?? DEFAULTS.vanceId], ['relayer', env.RELAYER_ID ?? DEFAULTS.relayerId]]
  return Promise.all(ids.map(async ([role, account]): Promise<Wallet> => {
    const w: Wallet = { account, role, nearYocto: (await near.balance(account).catch(() => 0n)).toString() }
    if (role === 'promoter') {
      try {
        w.baseAddress = await deriveEvmAddress(near, mpc, VANCE_PATH, account)
        w.baseWei = (await getBalance(base, w.baseAddress)).toString()
      } catch { /* the wallet card shows NEAR only when Base is unreachable */ }
    }
    return w
  }))
}

/** The latest closed season of a belt: the current one, or the one before the season that is open now. */
async function lastBellOf(chain: Chain, belt: RawBelt, load: (ids: number[]) => Promise<void>, tracks: Tracks) {
  const cur = belt.season
  const closed = cur?.state === 'Closed' ? cur : cur && cur.id > 1 ? await chain.season(belt.id, cur.id - 1) : null
  if (!closed || closed.state !== 'Closed') return null
  const list = await chain.payouts(belt.id, closed.id)
  await load(list.map((p) => p.id))
  return mapBell(closed, list, tracks, belt.promoter)
}

export async function buildState(env: Env, sim: Sim, near: Rpc, base: Rpc, now = Date.now()): Promise<StateResponse> {
  const chain = new Chain(env, near)
  const rb = sim.rulebook()
  const [cfg, rawBelts] = await Promise.all([chain.config(), chain.belts()])
  const belts = rawBelts.map((b) => mapBelt(b, rb)).filter((b): b is ChainBelt => b !== null)

  const perBelt = await Promise.all(rawBelts.map((b) => chain.fights(b.id, 0, 30)))
  const raw: RawFight[] = perBelt.flat().sort((a, b) => (BigInt(b.at) > BigInt(a.at) ? 1 : -1)).slice(0, 30)
  const tollOf = new Map(rawBelts.map((b) => [b.id, b.toll]))
  const names = new Map<string, string>()
  await Promise.all([...new Set(raw.flatMap((f) => [f.champion_hash, f.challenger_hash]))].map(async (h) => {
    const f = await chain.fighter(h)
    names.set(h, f?.spec.name ?? 'Unknown')
  }))
  const fights = raw.map((f) => mapFightSummary(f, { champion: names.get(f.champion_hash) ?? 'Unknown', challenger: names.get(f.challenger_hash) ?? 'Unknown' }, tollOf.get(f.belt_id) ?? '0'))

  const tracks: Tracks = new Map()
  const load = async (ids: number[]) => {
    for (const id of ids) if (!tracks.has(id)) tracks.set(id, await getJson<PayoutTrack>(env.TS_KV, trackKey(id)))
  }
  const payouts: PayoutState[] = []
  for (const b of rawBelts) {
    if (b.season?.state !== 'Closed') continue
    const list = await chain.payouts(b.id, b.season.id)
    await load(list.map((p) => p.id))
    for (const p of list) {
      const txHash = tracks.get(p.id)?.hash
      payouts.push({
        id: p.id, beltId: p.belt_id, seasonId: p.season_id, payee: p.payee, amountWei: p.amount_wei, to: p.to, nonce: p.nonce,
        status: payoutStatus(p, tracks.get(p.id) ?? null), ...(txHash ? { txHash, explorer: baseTxUrl(txHash) } : p.to ? { explorer: baseAddrUrl(p.to) } : {}),
      })
    }
  }
  // the bell cinematic on each belt card
  await Promise.all(belts.map(async (belt) => {
    const rawBelt = rawBelts.find((r) => r.id === belt.numericId)!
    belt.lastBell = await lastBellOf(chain, rawBelt, load, tracks)
  }))

  return {
    at: now, contract: chain.id, forgeMode: cfg.forge_mode, model: cfg.model_id, compiler: compilerOf(env), rulebookHash: rb.hash, rulebookMatch: requestMatches(sim, cfg),
    belts, fights, payouts, wallets: await cachedJson(env.TS_KV, 'wallets', 20, () => wallets(env, near, base), 40), tick: publicTick(await getJson<TickLog>(env.TS_KV, 'tick:last')),
  }
}
