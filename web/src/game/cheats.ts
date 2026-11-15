// "Try to cheat" (proof page): four calls a player can send from their own account that the contract is guaranteed to
// refuse. Every argument is prepared before the tap (a web wallet's sign tab must open within the tap, see
// test/wallet-tap.test.ts), each plan is checked by `assertRefused` before anything is signed, and the refusal code shown
// is read back from the failed transaction on chain, never assumed. Pinned by contract/src/tests/cheat_panel_tests.rs.
import type { NearWalletBase } from '@hot-labs/near-connect'
import { GameError } from './client'
import { Rpc, RpcError, contractCode, parseOutcome } from './chain/rpc'
import { Signer, TGAS } from './chain/signer'
import { parseSecretKey } from './chain/keys'
import { fn } from './chain/tx'
import type { StoredAccount } from './nearKeys'

export type CheatId = 'forge' | 'claim' | 'belt' | 'withdraw'
export const CHEAT_IDS: CheatId[] = ['forge', 'claim', 'belt', 'withdraw']
export const CHEAT_GAS = 10n * TGAS // each call panics within ~3 Tgas
/** NEAR the sender must hold to attach CHEAT_GAS: testnet reserves gas at up to 10x the gas price (1e8 yocto) up front and
 *  refunds what is unused, so a transaction from an account below this is dropped before it reaches the chain. */
export const CHEAT_PREPAID_YOCTO = CHEAT_GAS * 1_000_000_000n
/** More yoctoNEAR than can ever exist (total supply is ~1.2e33): no balance can reach it, so `withdraw` must refuse. */
export const U128_MAX = '340282366920938463463374607431768211455'
/** A burn address: what a cheater would name as the payout destination. */
export const CHEAT_ADDR = '0x000000000000000000000000000000000000dEaD'
export const nearRocksTx = (hash: string) => `https://testnet.near.rocks/tx/${hash}`

/** A fighter no rulebook allows (every stat maxed), "signed" by nobody: what a cheater would deliver as their own forge. */
export const FORGED_FIGHTER = { name: 'The Unbeatable Me', power: 10, speed: 10, guard: 10, stamina: 10, moves: ['win instantly'] }
const forgedOutput = () => JSON.stringify({
  ok: true, response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(FORGED_FIGHTER) } }] }),
  signature: `0x${'00'.repeat(65)}`, signing_address: `0x${'00'.repeat(20)}`, signing_algo: 'ecdsa', signature_kind: 'provider_tee', text: 'forged by the player',
})

export interface CheatPlan {
  id: CheatId
  method: 'submit_forge' | 'claim_payout' | 'nft_transfer' | 'withdraw'
  args: Record<string, unknown>
  /** yoctoNEAR attached: 1 where the method requires it (refunded when the call fails), else 0 */
  deposit: bigint
  /** the code the contract source says it must answer with */
  expect: string
  /** the thing being cheated, for the card: a challenge, a payout, a belt, a balance */
  target: string
}
export type Planned = { plan: CheatPlan } | { blocked: string }

export interface CheatContext {
  me: string
  /** the contract's listed relayers (from /api/proof); unknown (null) blocks the forge cheat */
  relayers: string[] | null
  payouts: { id: number; payee: string; to: string | null }[]
  belts: { id: string; name: string; holder?: string | null }[]
  /** a recent challenge id (stats.next_challenge_id - 1), for the forge cheat's target */
  challengeId: number | null
  balanceYocto: string | null
}

/** The plan for each cheat, from data read before the tap. A cheat that cannot be made safely is blocked with a reason. */
export function planCheat(id: CheatId, c: CheatContext): Planned {
  switch (id) {
    case 'forge':
      if (!c.relayers) return { blocked: 'Reading the relayer list…' }
      if (c.relayers.includes(c.me)) return { blocked: 'This account is a listed relayer, so it is not a cheat here.' }
      return { plan: { id, method: 'submit_forge', args: { challenge_id: c.challengeId ?? 0, output_json: forgedOutput() }, deposit: 0n, expect: 'E_NOT_RELAYER', target: c.challengeId === null ? 'a challenge' : `challenge #${c.challengeId}` } }
    case 'claim': {
      const theirs = c.payouts.filter((p) => p.payee !== c.me)
      const p = theirs.find((x) => !x.to) ?? theirs[0]
      if (!p) return { blocked: 'No purse share belongs to anyone else right now. One appears at the next bell.' }
      return { plan: { id, method: 'claim_payout', args: { payout_id: p.id, addr: CHEAT_ADDR }, deposit: 1n, expect: 'E_NOT_PAYEE', target: `payout #${p.id} of ${p.payee}` } }
    }
    case 'belt': {
      // receiver is always the sender: a non-holder gets E_NOT_HOLDER, and even the holder would get E_SELF
      const b = c.belts.find((x) => x.holder && x.holder !== c.me) ?? c.belts[0]
      if (!b) return { blocked: 'No belt is on the card right now.' }
      const mine = b.holder === c.me
      return { plan: { id, method: 'nft_transfer', args: { receiver_id: c.me, token_id: `belt-${b.id}`, approval_id: null, memo: 'mine now' }, deposit: 1n, expect: mine ? 'E_SELF' : 'E_NOT_HOLDER', target: `${b.name}${b.holder ? ` (held by ${b.holder})` : ''}` } }
    }
    case 'withdraw':
      return { plan: { id, method: 'withdraw', args: { amount: U128_MAX }, deposit: 1n, expect: 'E_BALANCE', target: c.balanceYocto === null ? 'your game balance' : `your game balance of ${(Number(c.balanceYocto) / 1e24).toFixed(3)} NEAR` } }
  }
}

/**
 * The rule the panel lives by, enforced before anything is signed: only these four calls, with arguments the contract
 * must refuse. Throws E_UNSAFE_CHEAT for anything else (a stale payout that is now ours, a relayer sender, a changed amount).
 */
export function assertRefused(p: CheatPlan, c: CheatContext): void {
  const bad = (why: string): never => { throw new GameError('E_UNSAFE_CHEAT', `Not sent: ${why}`) }
  if (p.deposit > 1n) bad('a cheat never attaches more than 1 yoctoNEAR')
  const a = p.args
  switch (p.method) {
    case 'submit_forge': if (!c.relayers || c.relayers.includes(c.me) || p.deposit !== 0n) bad('the sender could be a relayer'); return
    case 'claim_payout': {
      const payout = c.payouts.find((x) => x.id === a.payout_id)
      if (!payout || payout.payee === c.me) bad('that payout could be yours'); return
    }
    case 'nft_transfer': if (a.receiver_id !== c.me || a.approval_id !== null) bad('the belt would go to someone else'); return
    case 'withdraw': if (a.amount !== U128_MAX) bad('the amount could fit a balance'); return
    default: bad('unknown method')
  }
}

export interface CheatResult {
  hash: string
  /** the E_ code read from the failed receipt; null when the failure carried none */
  code: string | null
  /** true only if the chain says the call succeeded (it never should) */
  succeeded: boolean
  /** NEAR burnt as gas by the transaction and its receipts (yocto) */
  burntYocto: bigint
  gasBurnt: bigint
}

/** Read a final outcome: success or the refusal code, and what it burnt. */
export function readOutcome(hash: string, raw: any): CheatResult {
  const out = parseOutcome(raw)
  let burnt = 0n
  let gas = 0n
  for (const o of [raw?.transaction_outcome, ...(raw?.receipts_outcome ?? [])]) {
    if (!o?.outcome) continue
    burnt += BigInt(o.outcome.tokens_burnt ?? 0)
    gas += BigInt(o.outcome.gas_burnt ?? 0)
  }
  return { hash, code: out.failure ? contractCode(out.failure) : null, succeeded: !out.failure && out.status === 'SuccessValue', burntYocto: burnt, gasBurnt: gas }
}

/** Poll our own RPC for the transaction until it has executed: the code on screen comes from here, not from the wallet. */
export async function readBack(rpc: Rpc, hash: string, signer: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 60_000): Promise<CheatResult> {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await rpc.txStatus(hash, signer, 'EXECUTED_OPTIMISTIC')
      if (r?.status && r.status !== 'Unknown' && r.receipts_outcome?.length) return readOutcome(hash, r)
    } catch (e) {
      if (e instanceof RpcError && !/UNKNOWN_TRANSACTION|TIMEOUT|timeout/i.test(`${e.kind} ${e.message}`)) throw e
    }
    if (Date.now() - t0 > timeoutMs) throw new GameError('E_SLOW', `The transaction ${hash.slice(0, 8)}… has not reached the chain yet. If it never shows in the explorer, the network dropped it.`)
    await sleep(1200)
  }
}

export interface FireDeps {
  rpc: Rpc
  contract: string
  stored: StoredAccount
  /** the wallet, loaded before the tap (wallet accounts only) */
  wallet?: NearWalletBase | null
  onStage?: (s: 'approve' | 'sending' | 'reading') => void
  sleep?: (ms: number) => Promise<void>
}

const WALLET_HASH = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/

/** Send one cheat from the signed-in account, then read its outcome back from the chain. */
export async function fireCheat(p: CheatPlan, c: CheatContext, d: FireDeps): Promise<CheatResult> {
  assertRefused(p, c)
  const st = d.stored
  if (st.kind === 'wallet') {
    if (!d.wallet) throw new GameError('E_WALLET_GONE', 'Your wallet is still loading. Try again in a moment.')
    d.onStage?.('approve') // the wallet is called first: no network round trip between the tap and its sign tab
    let outcome: unknown
    try {
      outcome = await d.wallet.signAndSendTransaction({ signerId: st.accountId, network: 'testnet', receiverId: d.contract,
        actions: [{ type: 'FunctionCall', params: { methodName: p.method, args: p.args, gas: CHEAT_GAS.toString(), deposit: p.deposit.toString() } }] })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      const hash = WALLET_HASH.exec(m)?.[0]
      // some wallets throw on a failed transaction instead of returning it: read that transaction back like any other
      if (hash && contractCode(m)) { d.onStage?.('reading'); return readBack(d.rpc, hash, st.accountId, d.sleep) }
      if (/reject|denied|cancel|closed|declin|abort/i.test(m)) throw new GameError('E_WALLET_REJECTED', 'You declined it in your wallet. Nothing was sent.')
      throw new GameError('E_WALLET', `Your wallet could not send it: ${m.slice(0, 160)}`)
    }
    const r = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | null
    const hash = r?.transaction?.hash ?? r?.transaction_outcome?.id ?? ''
    if (!hash) throw new GameError('E_WALLET', 'Your wallet did not return the transaction hash.')
    d.onStage?.('reading')
    return readBack(d.rpc, hash, st.accountId, d.sleep)
  }
  if (!st.fullKey) throw new GameError('E_NO_ACCOUNT', 'This browser has no key for that account. Open the judge demo or connect a wallet.')
  d.onStage?.('sending')
  // a dropped transaction never lands: check the gas money first (no popup to protect on this path)
  const held = await d.rpc.balance(st.accountId).catch(() => null)
  if (held !== null && held < CHEAT_PREPAID_YOCTO) throw new GameError('E_GAS_BALANCE', `This account holds ${(Number(held) / 1e24).toFixed(4)} NEAR for gas; a try needs ${Number(CHEAT_PREPAID_YOCTO) / 1e24} NEAR up front (almost all of it comes back). Connect a wallet, or open a fresh judge demo.`)
  const signer = new Signer(st.accountId, parseSecretKey(st.fullKey), d.rpc)
  const hash = await signer.send(d.contract, [fn(p.method, p.args, CHEAT_GAS, p.deposit)])
  d.onStage?.('reading')
  return readBack(d.rpc, hash, st.accountId, d.sleep)
}
