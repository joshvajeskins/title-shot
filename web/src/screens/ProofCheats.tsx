// "Try to cheat": real refused transactions from the signed-in account, beside the recorded relayer runs of 14 Nov.
import { useEffect, useMemo, useState } from 'react'
import type { NearWalletBase } from '@hot-labs/near-connect'
import { Link } from '../components/Link'
import { Icon } from '../components/Icon'
import { useGame } from '../game/context'
import { Rpc } from '../game/chain/rpc'
import { browserStore, loadStored } from '../game/nearKeys'
import { CHEAT_IDS, fireCheat, nearRocksTx, planCheat, type CheatContext, type CheatId } from '../game/cheats'
import type { ApiProof, ApiStateFull } from '../game/nearApi'
import { CheatCard, type CardState } from './CheatCard'
import './proof-cheats.css'

const REPO = 'https://github.com/joshvajeskins/title-shot'
const RECORDED = [
  { k: 'a', what: 'NEAR AI’s genuine signed answer with one byte of the fighter changed ("power":6 → 9)', code: 'E_AI_SIG', tx: 'Cnmh5urEDPyC7ouKdy4oxcc7P8FomCR9yTxaymqge6Qq' },
  { k: 'b', what: 'A genuine signed answer for a different sentence, swapped in untouched', code: 'E_AI_SIG', tx: 'DQDXgmeDByFuvrzo4ffQFbsKPAvRUhJnesq9bhPFBPBQ' },
  { k: 'c', what: 'The right message format, signed by a random key that is not on the allowlist', code: 'E_AI_SIG', tx: '5EZFVkNEDxREDkty5bmNHfLZgrgTujJ1fjoACuvDnmiJ' },
  { k: 'd', what: 'A result that was already accepted, delivered a second time', code: 'E_NOT_FORGING', tx: '9zxVTFWDUzcdsk1eW3L4VwdRox4d41hk5AUjoejSxYqS' },
]
const IDLE: CardState = { stage: 'idle' }

export function ProofCheats({ proof, state }: { proof: ApiProof; state: ApiStateFull | null }) {
  const { client, account } = useGame()
  const rpc = useMemo(() => new Rpc(), [])
  const stored = useMemo(() => (account ? loadStored(browserStore()) : null), [account])
  const live = client.mode === 'testnet' && !!stored && stored.accountId === account?.id
  const [wallet, setWallet] = useState<NearWalletBase | null>(null)
  const [challengeId, setChallengeId] = useState<number | null>(null)
  const [cards, setCards] = useState<Record<CheatId, CardState>>({ forge: IDLE, claim: IDLE, belt: IDLE, withdraw: IDLE })

  // Everything a tap needs is read here, before any tap: the wallet itself and a recent challenge id.
  useEffect(() => {
    let on = true
    rpc.view<{ next_challenge_id: number }>(proof.contract, 'stats').then((s) => { if (on && s?.next_challenge_id) setChallengeId(s.next_challenge_id - 1) }).catch(() => undefined)
    return () => { on = false }
  }, [rpc, proof.contract])
  useEffect(() => {
    if (stored?.kind !== 'wallet') { setWallet(null); return }
    let on = true
    import('../game/wallet/connector').then((m) => m.walletFor(stored.accountId)).then((w) => { if (on) setWallet(w) }).catch(() => undefined)
    return () => { on = false }
  }, [stored])

  const ctx: CheatContext = {
    me: account?.id ?? '',
    relayers: proof.relayers ?? null,
    payouts: state?.payouts ?? [],
    belts: (state?.belts ?? []).map((b) => ({ id: String(b.numericId), name: b.name, holder: b.holder })),
    challengeId,
    balanceYocto: account?.balanceYocto ?? null,
  }
  const set = (id: CheatId, s: CardState) => setCards((c) => ({ ...c, [id]: s }))
  const send = (id: CheatId) => {
    const planned = planCheat(id, ctx)
    if (!('plan' in planned) || !stored) return
    fireCheat(planned.plan, ctx, { rpc, contract: proof.contract, stored, wallet, onStage: (stage) => set(id, { stage }) })
      .then((result) => set(id, { stage: 'done', result }))
      .catch((e: unknown) => set(id, { stage: 'error', error: e instanceof Error ? e.message : String(e) }))
  }

  return (
    <section id="cheat" className="tape-sec cheats">
      <h2 className="display sec-h">Try to cheat</h2>
      <p className="fair-sub">Send a real cheating transaction from your own account and watch the contract refuse it on NEAR testnet. Each try costs a little gas; where a method needs 1 yoctoNEAR attached, the refusal sends it back.</p>

      {!live ? (
        <div className="cheat-gate panel">
          <span className="serif-i">{client.mode === 'mock' ? 'This demo build has no chain to cheat.' : 'Step into the ring first.'}</span>
          <p>{client.mode === 'mock' ? 'Open the live testnet site to send these.' : 'Connect a wallet or open the judge demo. The four cheats below then go out from that account, and you watch each one fail on chain.'}</p>
          {client.mode !== 'mock' ? <Link href="/enter" className="btn btn-gold btn-sm">Connect or open the judge demo <Icon name="arrow" size={14} /></Link> : null}
        </div>
      ) : (
        <p className="cheat-as tape-dim">Sending as <code className="mono">{stored!.accountId}</code>{stored!.kind === 'wallet' ? ' · your wallet asks you to approve each one' : ' · judge demo: signed in this browser by its own key'}</p>
      )}

      <ol className="cheat-grid">
        {CHEAT_IDS.map((id, i) => (
          <CheatCard key={id} id={id} n={i + 1} planned={planCheat(id, ctx)} state={cards[id]} canSend={live && (stored?.kind !== 'wallet' || !!wallet)} onSend={() => send(id)} />
        ))}
      </ol>

      <h3 className="display fair-h3">Recorded samples</h3>
      <p className="cheat-rec-sub tape-dim">Run on 14 Nov by <code>scripts/cheat.mjs</code>: the listed relayer itself delivers tampered NEAR AI results. These are recordings, not your account.</p>
      <ol className="tape cheat-rec">
        {RECORDED.map((r) => (
          <li key={r.k} className="tape-row v-pass">
            <span className="tape-label">Case {r.k}</span>
            <div className="tape-value"><div className="tape-main">{r.what}</div>
              <p className="tape-note"><a href={nearRocksTx(r.tx)} target="_blank" rel="noreferrer" className="mono">{r.tx.slice(0, 10)}…</a> · <code className="mono">{r.code}</code></p></div>
            <span className="tape-verdict">Recorded</span>
          </li>
        ))}
      </ol>
      <a className="cheat-doc" href={`${REPO}/blob/main/docs/CHEAT-RESULTS.md`} target="_blank" rel="noreferrer">The full recorded run, with refunds <Icon name="external" size={12} /></a>
    </section>
  )
}
