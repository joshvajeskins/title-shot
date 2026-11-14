// "Use my NEAR wallet" on /enter: NEAR Connect sign-in, then ONE wallet approval that adds this browser's challenge-only
// session key and deposits the fight money. After that the wallet account plays exactly like a guest.
import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { Icon } from '../components/Icon'
import { NearMark, WalletTicket } from '../components/wallet/WalletTicket'
import type { Connected } from '../game/wallet/connector'
import { near } from '../lib/format'
import './enter-wallet.css'

type Phase =
  | { k: 'idle' }
  | { k: 'connecting' }
  | { k: 'setup'; c: Connected }
  | { k: 'approving'; c: Connected }
  | { k: 'confirming'; c: Connected }

const lazyWallet = () => Promise.all([import('../game/wallet/connector'), import('../game/wallet/setup')])

export function EnterWallet({ busyElsewhere, onBusy, onDone }: { busyElsewhere: boolean; onBusy: (b: boolean) => void; onDone: () => Promise<void> }) {
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const [err, setErr] = useState<string | null>(null)
  const [amount, setAmount] = useState<bigint | null>(null)
  useEffect(() => { onBusy(phase.k === 'connecting' || phase.k === 'approving' || phase.k === 'confirming') }, [phase.k, onBusy])

  // A reload after connecting (or mid-approval): NEAR Connect still remembers the wallet, so pick the ticket back up.
  useEffect(() => {
    let pending = false
    try { pending = !!localStorage.getItem('selected-wallet') } catch { /* blocked storage */ }
    if (!pending) return
    let live = true
    void import('../game/wallet/connector').then((m) => m.rememberedWallet()).then((c) => { if (live && c) setPhase({ k: 'setup', c }) }).catch(() => undefined)
    return () => { live = false }
  }, [])

  const connect = async () => {
    setErr(null); setPhase({ k: 'connecting' }); sound.play('ui_confirm')
    try {
      const [{ connectWallet }] = await lazyWallet()
      const c = await connectWallet()
      setPhase({ k: 'setup', c }); sound.play('ui_tick')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not open NEAR Connect.'); setPhase({ k: 'idle' })
      if (!/No wallet picked/.test(String((e as Error)?.message))) sound.play('ui_error')
    }
  }

  const disconnect = async () => {
    setErr(null); setPhase({ k: 'idle' })
    try { localStorage.removeItem('ts-wallet-pending') } catch { /* blocked storage */ }
    const { disconnectWallet } = await import('../game/wallet/connector')
    await disconnectWallet()
  }

  const approve = async (c: Connected, deposit: bigint) => {
    setErr(null); setPhase({ k: 'approving', c }); sound.play('ui_confirm')
    try {
      const [{ contractId }, { setupWallet }] = await lazyWallet()
      await setupWallet({ wallet: c.wallet, accountId: c.accountId, walletId: c.walletId, contract: contractId(), deposit, onStage: (s) => setPhase({ k: s === 'approve' ? 'approving' : 'confirming', c }) })
      sound.play('bell_ding')
      await onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The wallet setup did not finish.'); setPhase({ k: 'setup', c }); sound.play('ui_error')
    }
  }

  if (phase.k === 'idle' || phase.k === 'connecting') {
    return (
      <div className="ew">
        <div className="ew-or" aria-hidden="true"><span>or bring your own</span></div>
        <button className="btn btn-ghost ew-connect" onClick={connect} disabled={phase.k === 'connecting' || busyElsewhere}>
          <NearMark size={18} /> {phase.k === 'connecting' ? 'Opening NEAR Connect…' : 'Use my NEAR wallet'}
        </button>
        <p className="ew-sub">Meteor, Intear, Nightly, Ledger and more, on testnet. One approval, then no popups between fights.</p>
        {err && <p className="enter-err" role="alert"><Icon name="x" size={14} /> {err}</p>}
      </div>
    )
  }
  const c = phase.c
  const working = phase.k !== 'setup'
  return (
    <div className="ew">
      <WalletTicket connected={c} amount={amount} onAmount={setAmount} locked={working} onSwitch={disconnect} />
      <button className="btn btn-red btn-lg enter-cta ew-approve" disabled={working || amount === null} onClick={() => amount !== null && approve(c, amount)}>
        {phase.k === 'approving' ? <><span className="ew-dot" aria-hidden="true" /> Approve in {c.walletName}…</>
          : phase.k === 'confirming' ? <><span className="ew-dot" aria-hidden="true" /> Checking the chain…</>
          : amount === null ? 'Checking your wallet…'
          : amount === 0n ? <>Approve in wallet <Icon name="arrow" /></>
          : <>Approve · {near(amount, 2)} NEAR <Icon name="arrow" /></>}
      </button>
      {phase.k === 'approving' && <p className="ew-sub" role="status">Your wallet shows one request with {amount ? 'two transactions' : 'one transaction'}. Nothing leaves your wallet until you approve it there.</p>}
      {err && <p className="enter-err" role="alert"><Icon name="x" size={14} /> {err}</p>}
    </div>
  )
}
