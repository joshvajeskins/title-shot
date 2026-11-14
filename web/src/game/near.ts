// The on-chain GameClient: reads through /api/state (RPC fallback), signs `challenge` with the guest's session key,
// replays every fight in the bout-sim wasm and checks it against the contract's state hash.
import { cleanSentence, GameError, sentenceProblem, type FightSummary, type GameClient, type PreviewResult } from './client'
import type { Account, Belt, Fight, Fighter, ForgeProgress, Odds, Spec } from './types'
import { Rpc, RpcError, RpcUnavailable, contractCode, parseOutcome } from './chain/rpc'
import { Signer } from './chain/signer'
import { parseSecretKey } from './chain/keys'
import { fn } from './chain/tx'
import { challengeGas, txUrl } from './chain/config'
import { describeChallenge, formatNear, gameErrorFor, networkError } from './chain/errors'
import { computeOdds } from './chain/odds'
import { assembleFight, mapBelt, mapFighter, mapFightSummary, mapSplit, ruleOf, type ChainBelt, type RawBelt, type RawChallenge, type RawFight, type RawFighter } from './chain/views'
import { toChainSpec, loadSim, simIfReady, type Sim } from '../sim'
import { Api, type ApiState } from './nearApi'
import { evmAddr, fullKeyCall, readPayoutAddress, writePayoutAddress } from './chain/payout'
import { archiveStored, browserStore, clearPending, loadStored, pendingOrNewKeys, saveStoredIfFree, type KeyStore } from './nearKeys'

export interface NearClientOptions {
  contractId: string
  rpcUrls?: string[]
  apiBase?: string
  fetchFn?: typeof fetch
  store?: KeyStore
  sleep?: (ms: number) => Promise<void>
  /** poll interval for get_challenge, default 1500 ms */
  pollMs?: number
  /** how long challenge() waits for the forge before telling the player their toll is safe, default 240 s */
  forgeWaitMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class NearClient implements GameClient {
  readonly mode = 'testnet' as const
  readonly rpc: Rpc
  private api: Api
  private store: KeyStore
  private sleep: (ms: number) => Promise<void>
  private pollMs: number
  private forgeWaitMs: number
  private memo: { at: number; p: Promise<ApiState> } | null = null
  private challengeTx = new Map<number, string>()
  private fighterNames = new Map<string, string>()
  private contract: string

  constructor(o: NearClientOptions) {
    this.contract = o.contractId
    this.rpc = new Rpc({ urls: o.rpcUrls, fetchFn: o.fetchFn })
    this.api = new Api(o.apiBase ?? '', o.fetchFn)
    this.store = o.store ?? browserStore()
    this.sleep = o.sleep ?? defaultSleep
    this.pollMs = o.pollMs ?? 1500
    this.forgeWaitMs = o.forgeWaitMs ?? 240_000
    void loadSim().catch(() => undefined) // warm the wasm so odds() is ready when the Corner opens
  }

  private async sim(): Promise<Sim> {
    try { return await loadSim() } catch { throw new GameError('E_SIM', 'The fight engine failed to load. Reload the page.') }
  }

  private view<T>(method: string, args: unknown = {}): Promise<T> {
    return this.rpc.view<T>(this.contract, method, args).catch((e) => { throw networkError(e) })
  }

  // ---- account ----
  private stored() { return loadStored(this.store) }

  async account(): Promise<Account | null> {
    const st = this.stored()
    if (!st) return null
    let balance = '0'
    try { balance = String(await this.rpc.view<string>(this.contract, 'balance_of', { account: st.accountId })) } catch { /* show 0 rather than sign the player out */ }
    return { id: st.accountId, kind: 'guest', balanceYocto: balance, claimableYocto: '0' }
  }

  /** One shared in-flight request: a double click, two components or a re-render cannot create (and pay for) two guests. */
  private guestInFlight: Promise<Account> | null = null

  createGuest(): Promise<Account> {
    this.guestInFlight ??= this.makeGuest().finally(() => { this.guestInFlight = null })
    return this.guestInFlight
  }

  private async makeGuest(): Promise<Account> {
    const existing = await this.account()
    if (existing) return existing
    // saved before the request and reused by a retry: the server resumes the same account instead of funding a second one
    const keys = pendingOrNewKeys(this.store)
    const { accountId } = await this.api.guest(keys.fullPublic, keys.sessionPublic)
    // another tab may have stored an account while this request was out: its keys are never overwritten
    saveStoredIfFree(this.store, keys, accountId)
    clearPending(this.store)
    return (await this.account())!
  }

  async signOut(): Promise<void> { archiveStored(this.store) }

  // ---- bell payouts (Base Sepolia): the full-access key signs, since these need 1 yocto and the session key cannot ----
  /** The Base address registered for this account's purse payouts (lowercase), or null (none yet, or no guest corner). */
  async payoutAddress(): Promise<string | null> {
    const st = this.stored()
    return st ? readPayoutAddress(this.rpc, this.contract, st.accountId) : null
  }
  /** Register the Base address that receives this account's future purse payouts (set_evm_address, full-access key, 1 yocto). */
  async setPayoutAddress(addr: string): Promise<void> { const a = evmAddr(addr); await writePayoutAddress(this.rpc, this.contract, ...this.fullKey(), a) }
  /** Give a payout that was created without an address (claimable) the address it is paid to. Returns the tx hash. */
  async claimPayout(payoutId: number, addr: string): Promise<string> { const a = evmAddr(addr); return fullKeyCall(this.rpc, this.contract, ...this.fullKey(), 'claim_payout', { payout_id: payoutId, addr: a }) }

  private fullKey(): [string, string] {
    const st = this.stored()
    if (!st) throw new GameError('E_NO_ACCOUNT', 'Create your guest corner first.')
    return [st.accountId, st.fullKey]
  }

  // ---- reads ----
  private getState(): Promise<ApiState> {
    const now = Date.now()
    if (this.memo && now - this.memo.at < 3000) return this.memo.p
    const p = this.api.state().catch(async (e) => {
      try { return await this.directState() } catch { throw e }
    })
    this.memo = { at: now, p }
    p.catch(() => { if (this.memo?.p === p) this.memo = null })
    return p
  }

  /** When /api/state is down: build the same shape straight from the contract. */
  private async directState(): Promise<ApiState> {
    const sim = await this.sim()
    const rb = sim.rulebook()
    const raw = await this.view<RawBelt[]>('get_belts')
    const belts = raw.map((b) => mapBelt(b, rb)).filter((b): b is ChainBelt => b !== null)
    const fights: FightSummary[] = []
    for (const b of raw) {
      for (const f of await this.view<RawFight[]>('get_fights', { belt_id: b.id, from: 0, limit: 20 })) {
        fights.push(mapFightSummary(f, { champion: await this.nameOf(f.champion_hash), challenger: await this.nameOf(f.challenger_hash) }, b.toll))
      }
    }
    fights.sort((a, b) => b.at - a.at)
    return { at: Date.now(), contract: this.contract, forgeMode: 'unknown', model: '', rulebookHash: rb.hash, belts, fights: fights.slice(0, 30), payouts: [], wallets: [], tick: null }
  }

  private async nameOf(hash: string): Promise<string> {
    const hit = this.fighterNames.get(hash)
    if (hit) return hit
    const f = await this.view<RawFighter | null>('get_fighter', { hash_hex: hash })
    const name = f?.spec.name ?? 'Unknown'
    this.fighterNames.set(hash, name)
    return name
  }

  async belts(): Promise<Belt[]> {
    await this.sim().catch(() => undefined)
    return (await this.getState()).belts
  }

  async belt(id: string): Promise<Belt> {
    const b = (await this.belts()).find((x) => x.id === id)
    if (!b) throw new GameError('E_NO_BELT', 'That belt does not exist.')
    return b
  }

  async history(beltId?: string): Promise<FightSummary[]> {
    const f = (await this.getState()).fights
    return beltId ? f.filter((x) => x.beltId === beltId) : f
  }

  async preview(sentence: string): Promise<PreviewResult> {
    const problem = sentenceProblem(sentence)
    if (problem) throw new GameError('E_SENTENCE', problem)
    const p = await this.api.preview(cleanSentence(sentence))
    await this.sim().catch(() => undefined)
    return { spec: p.spec, portrait: p.portrait, canonical: p.canonical, signer: p.signer }
  }

  odds(champion: Spec, challenger: Spec, rule: number, n = 200): Odds {
    const sim = simIfReady()
    if (!sim) return { win: 0, draw: 0, loss: 0, n: 0 }
    return computeOdds(sim, champion, challenger, rule, n)
  }

  // ---- the fight ----
  private async fighterByHash(hash: string): Promise<Fighter> {
    const raw = await this.view<RawFighter | null>('get_fighter', { hash_hex: hash })
    if (!raw) throw new GameError('E_NO_FIGHTER', 'That fighter is not on chain.')
    return mapFighter(raw)
  }

  /** Read the bout, replay it in the wasm and compare with the contract's state hash. `verified` rides on the Fight. */
  async fight(id: string): Promise<Fight & { verified: boolean }> {
    const sim = await this.sim()
    const raw = await this.view<RawFight | null>('get_fight', { id: Number(id) })
    if (!raw) throw new GameError('E_NO_FIGHT', 'That fight does not exist.')
    const [champion, challenger, beltRaw] = await Promise.all([
      this.fighterByHash(raw.champion_hash), this.fighterByHash(raw.challenger_hash), this.view<RawBelt>('get_belt', { id: raw.belt_id }),
    ])
    const rb = sim.rulebook()
    const replay = sim.simulate(toChainSpec(champion.spec), toChainSpec(challenger.spec), raw.seed, raw.rule)
    if (!replay.ok) throw new GameError('E_SIM', 'The fight could not be replayed here.')
    const verified = replay.fight.state_hash === raw.state_hash && replay.fight.winner === raw.winner_code
    const tx = this.challengeTx.get(raw.challenge_id)
    const receipts = tx ? [{ label: 'challenge', tx, url: txUrl(tx) }] : []
    const rule = ruleOf(raw.rule, rb) ?? { id: raw.rule, name: `Rule ${raw.rule}`, desc: '' }
    const f = assembleFight(raw, champion, challenger, rule, replay.fight.events, mapSplit(raw.split, beltRaw.forge_fee, raw.storage), receipts)
    return { ...f, verified }
  }

  async challenge(beltId: string, sentence: string, onProgress: (p: ForgeProgress) => void): Promise<Fight> {
    const st = this.stored()
    if (!st) throw new GameError('E_NO_ACCOUNT', 'Create your guest corner first.')
    const clean = cleanSentence(sentence)
    const problem = sentenceProblem(clean)
    if (problem) throw new GameError('E_SENTENCE', problem)
    const belt = await this.belt(beltId)
    const toll = BigInt(belt.tollYocto)
    const balance = BigInt(String(await this.view<string>('balance_of', { account: st.accountId })))
    const pending = await this.view<RawChallenge | null>('get_pending', { account: st.accountId })
    let id: number
    let tx: string | null = null
    if (pending) {
      if (pending.sentence !== clean) throw gameErrorFor('E_PENDING')
      id = pending.id // reloaded mid-forge: pick the fight up where it was
    } else {
      if (balance < toll) throw gameErrorFor('E_BALANCE', { toll, balance })
      const signer = new Signer(st.accountId, parseSecretKey(st.sessionKey), this.rpc)
      const sent = await this.submit(signer, Number(beltId), clean, { toll, balance })
      id = sent.id
      tx = sent.hash
    }
    if (tx) this.challengeTx.set(id, tx)
    onProgress({ stage: 'toll', note: `${formatNear(toll)} NEAR toll paid from your balance`, ...(tx ? { receipt: { label: 'challenge', tx, url: txUrl(tx) } } : {}) })
    onProgress({ stage: 'tee', note: 'Forge request is on chain' })
    const fightId = await this.awaitForge(id, { toll, balance }, onProgress)
    const fight = await this.fight(String(fightId))
    onProgress({ stage: 'fight', note: fight.verified ? 'Bout resolved on chain and replayed here: hashes match' : 'Bout resolved on chain' })
    return fight
  }

  private forgeModeP: Promise<string> | null = null
  /** The contract's forge mode decides how much gas a challenge must attach (see challengeGas). Read once per page. */
  private forgeMode(): Promise<string> {
    this.forgeModeP ??= this.rpc.view<{ forge_mode?: string }>(this.contract, 'get_config', {}).then((c) => c?.forge_mode ?? 'relayer').catch(() => { this.forgeModeP = null; return 'relayer' })
    return this.forgeModeP
  }

  /** Send the challenge and learn its id from `get_pending` (or the tx result), surfacing a failed tx as a readable error. */
  private async submit(signer: Signer, beltId: number, sentence: string, ctx: { toll: bigint; balance: bigint }): Promise<{ id: number; hash: string }> {
    let hash: string
    try {
      hash = await signer.send(this.contract, [fn('challenge', { belt_id: beltId, sentence }, challengeGas(await this.forgeMode()), 0n)])
    } catch (e) {
      throw this.sendError(e)
    }
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const pend = await this.rpc.view<RawChallenge | null>(this.contract, 'get_pending', { account: signer.accountId }).catch(() => null)
      if (pend && pend.sentence === sentence) return { id: pend.id, hash }
      try {
        const out = parseOutcome(await this.rpc.txStatus(hash, signer.accountId, 'INCLUDED'))
        if (out.failure) throw gameErrorFor(contractCode(out.failure) ?? 'E_TX_FAILED', ctx)
        if (typeof out.value === 'number') return { id: out.value, hash }
      } catch (e) {
        if (e instanceof GameError) throw e
        if (e instanceof RpcError && !/UNKNOWN_TRANSACTION|timeout/i.test(e.kind + e.message)) throw networkError(e)
      }
      await this.sleep(this.pollMs)
    }
    throw new GameError('E_SLOW', 'The network is slow. Your challenge may still land: check the Fight Book in a minute.')
  }

  private sendError(e: unknown): GameError {
    const m = e instanceof Error ? e.message : String(e)
    if (/NotEnoughAllowance|allowance/i.test(m)) return new GameError('E_ALLOWANCE', 'This guest corner has used up its gas allowance. Create a new guest corner to keep fighting.')
    if (/NotEnoughBalance|LackBalanceForState/i.test(m)) return new GameError('E_GAS_BALANCE', 'This guest corner is out of gas money. Create a new guest corner.')
    if (/MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall/i.test(m)) return new GameError('E_KEY', 'This corner\'s key cannot sign that action.')
    if (e instanceof RpcUnavailable || e instanceof RpcError) return networkError(e)
    return networkError(e)
  }

  /** Poll get_challenge until it leaves Forging; stream compile/verify progress; return the fight id. */
  private async awaitForge(id: number, ctx: { toll: bigint; balance: bigint }, onProgress: (p: ForgeProgress) => void): Promise<number> {
    const t0 = Date.now()
    for (;;) {
      let c: RawChallenge | null = null
      try { c = await this.rpc.view<RawChallenge | null>(this.contract, 'get_challenge', { id }) } catch { /* transient: keep polling */ }
      const d = describeChallenge(c, ctx)
      if (d.phase === 'failed') throw new GameError(d.code, d.message)
      if (d.phase === 'resolved') {
        if (d.fightId === null) throw new GameError('E_STATE', 'The forge finished without a fight. Your toll was refunded minus the forge fee.')
        onProgress({ stage: 'compile', note: 'NEAR AI compiled your sentence (signed in a TEE)' })
        await this.sleep(450)
        onProgress({ stage: 'verify', note: 'The contract checked the AI signature (ecrecover) and the point budget' })
        await this.sleep(450)
        return d.fightId
      }
      if (Date.now() - t0 > this.forgeWaitMs) throw new GameError('E_SLOW', 'The forge is taking longer than usual. Your toll is safe: it is refunded automatically after 10 minutes. Check the Fight Book.')
      await this.sleep(this.pollMs)
    }
  }
}
