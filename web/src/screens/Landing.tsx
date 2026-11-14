import { useEffect, useRef, useState } from 'react'
import { sound } from '../audio/sound'
import { Icon } from '../components/Icon'
import { Link, Wordmark } from '../components/Link'
import { useAsync, useGame } from '../game/context'
import { useCompilerMode } from '../game/compiler'
import { BeltBill } from './landing/BeltBill'
import { Loop } from './landing/Loop'
import { Money } from './landing/Money'
import { SlamTitle } from './landing/SlamTitle'
import { useReveal } from './landing/useReveal'
import './landing.css'
import './landing/bills.css'

/** "How we keep it fair" opens the proof page at its fair-play section (the client router drops hashes). */
function openFair(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault()
  history.pushState(null, '', '/play/proof#fair')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function Landing() {
  const { client, account } = useGame()
  const { data: belts, error } = useAsync(() => client.belts(), [client])
  const [started, setStarted] = useState(false)
  const compiler = useCompilerMode(client.mode)
  const root = useRef<HTMLDivElement>(null)
  useReveal(root)
  useEffect(() => { document.title = 'TITLE SHOT — one sentence, one belt' }, [])
  const start = () => { if (!started) { setStarted(true); void sound.music('lobby_loop'); sound.play('intro_1') } }
  const cta = account ? { href: '/play', label: 'Open the belts' } : { href: '/enter', label: 'Connect wallet and play' }
  return (
    <div className="landing" ref={root} onPointerDown={start}>
      <header className="land-nav">
        <Wordmark size={28} />
        <nav>
          <a href="#loop">How it plays</a>
          <a href="#money">The money</a>
          <a href="/play/proof#fair" onClick={openFair}>Fair play</a>
          <Link href={cta.href} className="btn btn-red btn-sm">{account ? 'Open the belts' : 'Play'}</Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-art" aria-hidden="true"><img src="/art/keyart.webp" alt="" /></div>
        <div className="hero-copy">
          <span className="eyebrow hero-in">A NEAR game with a real economy · live on testnet</span>
          {compiler === 'standin' && <span className="chip chip-gold hero-mode">Staging contract: fighters compiled by a labeled stand-in until the NEAR AI key lands</span>}
          {compiler === 'mock' && <span className="chip hero-mode">Offline demo: simulated chain</span>}
          <SlamTitle />
          <p className="hero-sub hero-in">Write one sentence. An attested AI forges it into a fighter. Pay the toll, fight the champion, take the belt. Win or lose, your toll pays the champ.</p>
          <div className="hero-cta hero-in">
            <Link href={cta.href} className="btn btn-red btn-lg bell-cta">{cta.label} <Icon name="arrow" /></Link>
            <a href="#loop" className="btn btn-ghost btn-lg">How it plays</a>
          </div>
        </div>
        <BeltBill belts={belts} error={error} />
      </section>

      <Loop />
      <Money />

      <section className="land-cta">
        <div className="bill vance" data-reveal><img src="/art/promoter-vance.webp" alt="" /></div>
        <div className="land-cta-copy" data-reveal style={{ '--d': '80ms' } as React.CSSProperties}>
          <h2 className="display print">The belts are open</h2>
          <p className="serif-i">“Bring me one good sentence, kid.” Velvet Vance, promoter</p>
          <div className="land-cta-row">
            <Link href={cta.href} className="btn btn-red btn-lg bell-cta">{cta.label} <Icon name="arrow" /></Link>
            <a href="/play/proof#fair" onClick={openFair} className="fair-link">How we keep it fair →</a>
          </div>
        </div>
      </section>

      <footer className="land-foot">
        <Wordmark size={22} />
        <span>Built for the NEAR HACKATHON · Games With Real Economies</span>
        <nav><a href="https://github.com/joshvajeskins/title-shot" target="_blank" rel="noreferrer">Source</a><Link href="/play/how">How it works</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link></nav>
      </footer>
    </div>
  )
}
