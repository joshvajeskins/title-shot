// "Move to my wallet" for a guest: connect a NEAR wallet, prove control with a NEP-413 signed message, review exactly what
// moves, then the guest's own full-access key (in this browser) withdraws the balance, transfers every belt and sends its NEAR.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { sound } from '../../audio/sound'
import { useGame } from '../../game/context'
import { browserStore, loadStored } from '../../game/nearKeys'
import type { Connected } from '../../game/wallet/connector'
import type { MovePlan, MoveStep, MoveStepId } from '../../game/wallet/move'
import type { Receipt } from '../../game/wallet/setup'
import { near } from '../../lib/format'
import { Icon } from '../Icon'
import { NearMark } from './WalletTicket'
import { isEmpty, MoveReview, MoveSteps } from './MoveParts'
import './wallet.css'

/** Fight money "Play from my wallet" deposits: the game balance just moved, or 0.2 NEAR when that was less. */
const DEFAULT_BACK = 10n ** 24n / 5n
const fightMoneyBack = (p: MovePlan): bigint => (p.balance >= DEFAULT_BACK ? p.balance : DEFAULT_BACK)

type Phase ='connect' | 'connecting' | 'proving' | 'planning' | 'review' | 'moving' | 'done' | 'playing'

const mods = () => Promise.all([import('../../game/wallet/connector'), import('../../game/wallet/prove'), import('../../game/wallet/move'), import('../../game/chain/rpc')])

export function MoveDialog({ onClose }: { onClose: () => void }) {
  const { refreshAccount } = useGame()
  const guest = loadStored(browserStore())
  const [phase, setPhase] = useState<Phase>('connect')
  const [err, setErr] = useState<string | null>(null)
  const [conn, setConn] = useState<Connected | null>(null)
  const [plan, setPlan] = useState<MovePlan | null>(null)
  const [steps, setSteps] = useState<Partial<Record<MoveStepId, MoveStep>>>({})
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const busy = phase === 'connecting' || phase === 'proving' || phase === 'planning' || phase === 'moving' || phase === 'playing'
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [busy, onClose])
  if (!guest || guest.kind === 'wallet') return null

  const fail = (e: unknown, back: Phase) => { setErr(e instanceof Error ? e.message : String(e)); setPhase(back); sound.play('ui_error') }

  const connect = async () => {
    setErr(null); setPhase('connecting')
    let c: Connected
    try {
      const [{ connectWallet }] = await mods()
      c = await connectWallet({ signMessage: true })
      if (c.accountId === guest.accountId) throw new Error('That wallet is this guest account. Connect a different NEAR account.')
      setConn(c)
    } catch (e) { fail(e, 'connect'); return }
    await prove(c)
  }

  const prove = async (c: Connected) => {
    setErr(null); setPhase('proving')
    try {
      const [{ contractId, rpcUrls }, { proveControl }, { planMove }, { Rpc }] = await mods()
      await proveControl(c.wallet, c.accountId, guest.accountId)
      setPhase('planning')
      setPlan(await planMove(new Rpc({ urls: rpcUrls() }), contractId(), guest.accountId, c.accountId))
      setPhase('review'); sound.play('ui_tick')
    } catch (e) { fail(e, 'connect') }
  }

  const move = async () => {
    if (!plan) return
    setErr(null); setPhase('moving'); sound.play('ui_confirm')
    try {
      const [{ contractId, rpcUrls }, , { executeMove }, { Rpc }] = await mods()
      const got = await executeMove(plan, { rpc: new Rpc({ urls: rpcUrls() }), contract: contractId(), fullKey: guest.fullKey, onStep: (s) => setSteps((m) => ({ ...m, [s.id]: s })) })
      setReceipts(got); setPhase('done'); sound.play('bell_ding')
      await refreshAccount()
    } catch (e) { fail(e, 'done') }
  }

  const play = async () => {
    if (!conn) return
    setErr(null); setPhase('playing')
    try {
      const [[{ contractId }], { setupWallet }] = await Promise.all([mods(), import('../../game/wallet/setup')])
      await setupWallet({ wallet: conn.wallet, accountId: conn.accountId, walletId: conn.walletId, contract: contractId(), deposit: plan ? fightMoneyBack(plan) : DEFAULT_BACK })
      await refreshAccount(); sound.play('bell_ding'); onClose()
    } catch (e) { fail(e, 'done') }
  }

  return createPortal(
    <div className="wm-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="wm panel" role="dialog" aria-modal="true" aria-labelledby="wm-title">
        <button className="wm-close" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="x" size={16} /></button>
        <span className="eyebrow">Guest corner · {guest.accountId}</span>
        <h2 id="wm-title" className="display print">{phase === 'done' ? 'Moved' : 'Move to my wallet'}</h2>
        {(phase === 'connect' || phase === 'connecting') && (
          <>
            <p>Everything this guest owns goes to a NEAR wallet you control: the game balance, any belt, and the account's own NEAR. First your wallet signs a short message to prove the account is yours (no transaction, no gas).</p>
            <button className="btn btn-ghost wm-wide" onClick={connect} disabled={busy}><NearMark size={18} /> {phase === 'connecting' ? 'Opening NEAR Connect…' : 'Connect a NEAR wallet'}</button>
          </>
        )}
        {(phase === 'proving' || phase === 'planning') && conn && (
          <div className="wm-wait" role="status"><span className="ew-dot" aria-hidden="true" />{phase === 'proving' ? <span>Sign the message in {conn.walletName} to prove <b>{conn.accountId}</b> is yours.</span> : <span>Counting what <b>{guest.accountId}</b> holds…</span>}</div>
        )}
        {phase === 'review' && plan && <MoveReview plan={plan} walletName={conn?.walletName ?? 'your wallet'} />}
        {(phase === 'moving' || phase === 'done' || phase === 'playing') && plan && <MoveSteps plan={plan} steps={steps} />}
        {err && <p className="wm-err" role="alert"><Icon name="x" size={14} /> {err}</p>}
        <div className="wm-actions">
          {phase === 'review' && plan && (
            <>
              <button className="btn btn-red" onClick={move} disabled={plan.pending || isEmpty(plan)}>Move everything <Icon name="arrow" /></button>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            </>
          )}
          {(phase === 'done' || phase === 'playing') && !err && receipts.length > 0 && conn && (
            <>
              <button className="btn btn-red" onClick={play} disabled={busy}>{phase === 'playing' ? `Approve in ${conn.walletName}…` : <>Play from {conn.accountId.length > 22 ? 'my wallet' : conn.accountId} <Icon name="arrow" /></>}</button>
              <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Close</button>
            </>
          )}
          {phase === 'done' && (err || receipts.length === 0) && <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>}
        </div>
        {phase === 'done' && !err && plan && <p className="wm-note">Play from {conn?.accountId} adds a challenge-only session key in one wallet approval and deposits {near(fightMoneyBack(plan), 3)} NEAR of fight money{plan.balance >= DEFAULT_BACK ? ' (the balance you just moved)' : ''}. This guest's keys stay in this browser's archive.</p>}
      </div>
    </div>,
    document.body,
  )
}
