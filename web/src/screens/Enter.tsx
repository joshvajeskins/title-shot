import { useCallback, useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { Icon } from '../components/Icon'
import { Link, Wordmark } from '../components/Link'
import { useGame } from '../game/context'
import { navigate } from '../lib/router'
import { EnterWallet } from './EnterWallet'
import './enter.css'

function nextPath(): string {
  const n = new URLSearchParams(location.search).get('next') ?? '/play'
  return n.startsWith('/play') ? n : '/play'
}

export function Enter() {
  const { client, account, ready, setAccount } = useGame()
  const [busy, setBusy] = useState(false)
  const [walletBusy, setWalletBusy] = useState(false)
  const onWalletBusy = useCallback((b: boolean) => setWalletBusy(b), [])
  const walletDone = useCallback(async () => { const a = await client.account(); setAccount(a); navigate(nextPath(), { replace: true }) }, [client, setAccount])
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (ready && account) navigate(nextPath(), { replace: true }) }, [ready, account])
  const create = async () => {
    setBusy(true); setErr(null); sound.play('ui_confirm')
    try { const a = await client.createGuest(); setAccount(a); sound.play('bell_ding'); navigate(nextPath(), { replace: true }) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not open an account right now.'); sound.play('ui_error') }
    finally { setBusy(false) }
  }
  return (
    <div className="enter">
      <section className="enter-form">
        <div className="enter-top">
          <Link href="/"><Wordmark size={28} /></Link>
          <Link href="/" className="enter-back"><Icon name="back" size={14} /> Back to site</Link>
        </div>
        <div className="enter-body">
          <span className="eyebrow">Your corner</span>
          <h1 className="display print enter-h">Get in the ring</h1>
          <p className="enter-p">Connect your NEAR testnet wallet. It approves once: a key that can only call <i>challenge</i>, and the fight money you choose. After that, no popups between fights. Withdrawals go back through your wallet; purse payouts go to the Base address you pick.</p>
          {client.mode === 'testnet' && <EnterWallet busyElsewhere={busy} onBusy={onWalletBusy} onDone={walletDone} />}
          <div className="enter-demo">
            <div className="ew-or" aria-hidden="true"><span>or</span></div>
            <span className="enter-route-tag"><Icon name="bolt" size={12} /> Judge demo: no wallet</span>
            <p className="ew-sub">For judges and AI screeners who can't run a wallet extension. We open a throwaway testnet demo account in this browser, funded with test NEAR. It is not your wallet; its winnings can be moved to your wallet later.</p>
            <button className="btn btn-ghost enter-demo-btn" onClick={create} disabled={busy || walletBusy}>
              {busy ? 'Opening the demo account…' : <>Open the judge demo <Icon name="arrow" /></>}
            </button>
          </div>
          {err && <p className="enter-err" role="alert"><Icon name="x" size={14} /> {err}</p>}
          <ul className="enter-facts">
            <li><Icon name="lock" size={14} /><span>The session key can only call <i>challenge</i>: it cannot withdraw, move your belt or touch your wallet</span></li>
            <li><Icon name="check" size={14} /><span>Winnings, belts and purse payouts land in your own NEAR and Base wallets</span></li>
            <li><Icon name="coin" size={14} /><span>Testnet NEAR has no cash value. This is a demo economy on testnet.</span></li>
          </ul>
          <p className="enter-terms">By entering you agree to the <Link href="/terms">terms</Link> and the <Link href="/privacy">privacy note</Link>.</p>
        </div>
      </section>
      <aside className="enter-art" aria-hidden="true">
        <img src="/art/keyart.webp" alt="" />
        <blockquote className="enter-quote">
          <img src="/art/promoter-vance.webp" alt="" />
          <span className="serif-i">“Bring me one good sentence, kid. I'll handle the rest.”</span>
          <small>Velvet Vance, promoter</small>
        </blockquote>
      </aside>
    </div>
  )
}
