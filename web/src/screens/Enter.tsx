import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { Icon } from '../components/Icon'
import { Link, Wordmark } from '../components/Link'
import { useGame } from '../game/context'
import { navigate } from '../lib/router'
import './enter.css'

function nextPath(): string {
  const n = new URLSearchParams(location.search).get('next') ?? '/play'
  return n.startsWith('/play') ? n : '/play'
}

export function Enter() {
  const { client, account, ready, setAccount } = useGame()
  const [busy, setBusy] = useState(false)
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
          <span className="eyebrow">Fighter account</span>
          <h1 className="display print enter-h">Get in the ring</h1>
          <p className="enter-p">One tap opens a NEAR testnet account for you, loads it with free test NEAR and keeps a session key in this browser. No email, no seed phrase, no wallet popups between fights.</p>
          <button className="btn btn-red btn-lg enter-cta" onClick={create} disabled={busy}>
            {busy ? 'Opening your account…' : <>Create my fighter account <Icon name="arrow" /></>}
          </button>
          {err && <p className="enter-err" role="alert"><Icon name="x" size={14} /> {err}</p>}
          <ul className="enter-facts">
            <li><Icon name="check" size={14} /> A real NEAR account on testnet, yours to keep</li>
            <li><Icon name="lock" size={14} /> The session key can only call <i>challenge</i>: it cannot withdraw or move your belt</li>
            <li><Icon name="coin" size={14} /> Testnet NEAR has no cash value. This is a demo economy on testnet.</li>
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
