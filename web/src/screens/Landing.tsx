import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import { Icon } from '../components/Icon'
import { Link, Wordmark } from '../components/Link'
import { useAsync, useGame } from '../game/context'
import { eth, near } from '../lib/format'
import './landing.css'

const STACK = [
  { k: 'NEAR AI Cloud', role: 'The compiler', d: 'A model running inside a TEE turns your sentence into stats and moves under a public rulebook, and signs its answer. The contract checks that signature with ecrecover.' },
  { k: 'OutLayer', role: 'The sealed forge', d: 'Each paid challenge runs forge.wasm exactly once inside Intel TDX, with the API key as a secret no operator sees, and draws the fight seed from a VRF.' },
  { k: 'NEAR contract', role: 'The referee', d: 'The fight runs inside the contract from a shared Rust crate. Your browser runs the same crate, so the replay you watch hashes to the same result.' },
  { k: 'Function-call keys', role: 'No popups', d: 'A session key that can only call challenge. It cannot withdraw, move the belt or touch your balance outside the toll.' },
  { k: 'Chain Signatures', role: 'The purse', d: 'Each season’s purse sits at a Base address derived from the contract. Only the bell can sign it out, only to the winners. Nobody holds that key.' },
  { k: 'NEP-171', role: 'The belt', d: 'The title is a token. Whoever holds it collects the champion’s share of every challenge, and can even sell it.' },
]

export function Landing() {
  const { client, account } = useGame()
  const { data: belts } = useAsync(() => client.belts(), [client])
  const [started, setStarted] = useState(false)
  useEffect(() => { document.title = 'TITLE SHOT — one sentence, one belt' }, [])
  const start = () => { if (!started) { setStarted(true); void sound.music('lobby_loop'); sound.play('intro_1') } }
  const cta = account ? { href: '/play', label: 'Open the belts' } : { href: '/enter', label: 'Enter the ring' }
  return (
    <div className="landing" onPointerDown={start}>
      <header className="land-nav">
        <Wordmark size={28} />
        <nav>
          <a href="#loop">How it plays</a>
          <a href="#money">The money</a>
          <a href="#fair">Fair by construction</a>
          <Link href={cta.href} className="btn btn-red btn-sm">{account ? 'Open the belts' : 'Play'}</Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-art" aria-hidden="true"><img src="/art/keyart.webp" alt="" /></div>
        <div className="hero-copy">
          <span className="eyebrow">A NEAR game with a real economy · live on testnet</span>
          <h1 className="display hero-title"><span className="print">Title</span> <span className="hero-shot">Shot</span></h1>
          <p className="hero-sub">Write one sentence. An attested AI forges it into a fighter. Pay the toll, fight the champion, take the belt. Lose, and your toll pays the champ.</p>
          <div className="hero-cta">
            <Link href={cta.href} className="btn btn-red btn-lg">{cta.label} <Icon name="arrow" /></Link>
            <a href="#loop" className="btn btn-ghost btn-lg">How it plays</a>
          </div>
          {belts && (
            <div className="hero-ticker">
              {belts.map((b) => (
                <Link key={b.id} href={`/play/belt/${b.id}`} className="ticker-item">
                  <img src={b.art} alt="" />
                  <span><b>{b.champion.spec.name}</b> holds the {b.name.replace('The ', '')} · {b.defences} defences · purse {eth(b.season.purse.amountWei)} ETH</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <section id="loop" className="land-sec">
        <h2 className="display print sec-title">One sentence. Thirty seconds.</h2>
        <p className="sec-sub">The skill is wordsmithing against the champion. Everything else is the show.</p>
        <ol className="loop">
          <li><span className="loop-n display">01</span><div className="loop-art loop-write paper"><span className="serif-i">a pigeon with a law degree</span></div><h3 className="display">Write</h3><p>Type up to 120 characters. Spar for free and see your odds against the champion before you pay a thing.</p></li>
          <li><span className="loop-n display">02</span><div className="loop-art"><img src="/art/forge-press.webp" alt="" /></div><h3 className="display">Forge</h3><p>The AI reads it once, in a sealed enclave, and prints a fighter: a face, four stats, three moves named after your words.</p></li>
          <li><span className="loop-n display">03</span><div className="loop-art loop-fight"><FighterPoster spec={{ name: 'Counselor Coo', title: '', look: '', cry: '', school: 'MIND', style: 'TACTICIAN', moves: [], stats: { power: 14, guard: 18, speed: 25, grit: 13 } }} portrait="/art/fighter-pigeon.webp" size="sm" tilt={-4} showSentence={false} /><FighterPoster spec={{ name: 'Granny Purl', title: '', look: '', cry: '', school: 'IRON', style: 'COUNTERPUNCHER', moves: [], stats: { power: 10, guard: 25, speed: 10, grit: 25 } }} portrait="/art/fighter-grandma.webp" size="sm" tilt={4} showSentence={false} /></div><h3 className="display">Fight</h3><p>Best of three, refereed by the contract. A draw keeps the champion. Rematch in one tap.</p></li>
          <li><span className="loop-n display">04</span><div className="loop-art"><img src="/art/belt-midnight.webp" alt="" /></div><h3 className="display">Hold the belt</h3><p>Win and every failed challenger pays you. Hold it when the bell rings and you take the purse.</p></li>
        </ol>
      </section>

      <section id="money" className="land-sec money">
        <h2 className="display print sec-title">Where the money goes</h2>
        <p className="sec-sub">No token, no emissions, no faucet. Closed seasons, funded up front. The champion is paid for being the target.</p>
        <div className="money-grid">
          <div className="money-card panel">
            <span className="eyebrow">Every challenge · {near('100000000000000000000000')} NEAR toll</span>
            <div className="split-bar" role="img" aria-label="Toll split">
              <span style={{ flexGrow: 54 }} className="sb-champ">Champion 54%</span>
              <span style={{ flexGrow: 22.5 }} className="sb-prom">Promoter</span>
              <span style={{ flexGrow: 10 }} className="sb-forge">Forge</span>
              <span style={{ flexGrow: 9 }} className="sb-pot">Pot</span>
              <span style={{ flexGrow: 4.5 }} className="sb-house">House</span>
            </div>
            <ul className="money-list">
              <li><b>54%</b> to the champion's holder, win or lose: they are the target.</li>
              <li><b>22.5%</b> to the promoter who funded the purse and wrote the opener.</li>
              <li><b>10%</b> forge fee: the enclave run and the AI call, at cost.</li>
              <li><b>9%</b> into the season side-pot, paid at the bell. <b>4.5%</b> to the house.</li>
            </ul>
          </div>
          <div className="money-card panel">
            <span className="eyebrow">At the bell · the purse</span>
            <div className="bell-split">
              <div><b className="display">50%</b><span>to whoever holds the belt</span></div>
              <div><b className="display">50%</b><span>split by successful defences, capped at 25% per account</span></div>
            </div>
            <p className="money-note">The cap is there because sniping exists: a late challenger who takes the belt in the last minute gets half the purse, not all of it. A self-challenge through a second account always loses money: the forge fee and house share never come back.</p>
          </div>
        </div>
      </section>

      <section id="fair" className="land-sec">
        <h2 className="display print sec-title">Fair by construction</h2>
        <p className="sec-sub">Six pieces of NEAR, each doing one job you can check. Pull any one out and the game loses something you can name.</p>
        <div className="stack">
          {STACK.map((s) => (
            <article key={s.k} className="stack-card panel">
              <span className="eyebrow">{s.role}</span>
              <h3 className="display">{s.k}</h3>
              <p>{s.d}</p>
            </article>
          ))}
        </div>
        <div className="limits panel">
          <h3 className="display">What we don't claim</h3>
          <ul>
            <li>The model and rulebook are public, so anyone can search for strong sentences offline, bots included. The sealed season rule, the defence-weighted purse and the per-account cap blunt that; they don't stop it.</li>
            <li>The AI signer allowlist is set by an admin from the model's attestation report. Changes are timelocked and public.</li>
            <li>This runs on NEAR testnet and Base Sepolia. Testnet tokens have no cash value.</li>
          </ul>
        </div>
      </section>

      <section className="land-cta">
        <img src="/art/promoter-vance.webp" alt="" />
        <div>
          <h2 className="display print">The belts are open</h2>
          <p className="serif-i">“Bring me one good sentence, kid.” Velvet Vance, promoter</p>
          <Link href={cta.href} className="btn btn-red btn-lg">{cta.label} <Icon name="arrow" /></Link>
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
