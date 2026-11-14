import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import { Icon } from '../components/Icon'
import { Link, Wordmark } from '../components/Link'
import { useAsync, useGame } from '../game/context'
import { eth, near } from '../lib/format'
import { useCompilerMode } from '../game/compiler'
import './landing.css'

const STACK = [
  { k: 'NEAR AI Cloud', role: 'The compiler', d: 'A model running inside a TEE turns your sentence into stats and moves under a public rulebook, and signs its answer. The contract checks that signature with ecrecover.' },
  { k: 'OutLayer', role: 'The sealed forge', d: 'forge.wasm is built for OutLayer’s Intel TDX workers, with the API key sealed to the game contract and the fight seed from a VRF. On testnet OutLayer does not return our compile runs yet, so a listed relayer delivers NEAR AI’s signed answer instead. The contract checks it the same way, and the tale of the tape shows which mode is live.' },
  { k: 'NEAR contract', role: 'The referee', d: 'The fight runs inside the contract from a shared Rust crate. Your browser runs the same crate, so the replay you watch hashes to the same result.' },
  { k: 'Function-call keys', role: 'No popups', d: 'A session key that can only call challenge. It cannot withdraw, move the belt or touch your balance outside the toll.' },
  { k: 'Chain Signatures', role: 'The purse', d: 'Each season’s purse sits at a Base address derived from the contract. Only the bell can sign it out, only to the winners. Nobody holds that key.' },
  { k: 'NEP-171', role: 'The belt', d: 'The title is a token. Whoever holds it collects the champion’s share of every challenge, and can hand it to another account with nft_transfer.' },
]

const BEYOND = [
  { k: 'x402 on Base', role: 'The box office', d: 'AI agents buy a title shot with test USDC on Base. The payment lands at the promoter’s Chain Signatures address and the fight is booked on NEAR. Bots that hunt for strong sentences pay the champion like everyone else.' },
  { k: 'Basenames', role: 'Names, not hex', d: 'Purses pay to you.basetest.eth. The promoter owns velvetvance.basetest.eth, registered by a NEAR account through an MPC signature.' },
  { k: 'TDX + GPU attestation', role: 'The allowlist, checked', d: 'A script checks NEAR AI’s Intel TDX quote, GPU evidence and booted code, and that the attested signing key is the one the contract trusts.' },
]

export function Landing() {
  const { client, account } = useGame()
  const { data: belts } = useAsync(() => client.belts(), [client])
  const [started, setStarted] = useState(false)
  const compiler = useCompilerMode(client.mode)
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
          {compiler === 'standin' && <span className="chip chip-gold hero-mode">Staging contract: fighters compiled by a labeled stand-in until the NEAR AI key lands</span>}
          {compiler === 'mock' && <span className="chip hero-mode">Offline demo: simulated chain</span>}
          <h1 className="display hero-title"><span className="print">Title</span> <span className="hero-shot">Shot</span></h1>
          <p className="hero-sub">Write one sentence. An attested AI forges it into a fighter. Pay the toll, fight the champion, take the belt. Win or lose, your toll pays the champ.</p>
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
          <li><span className="loop-n display">02</span><div className="loop-art"><img src="/art/forge-press.webp" alt="" /></div><h3 className="display">Forge</h3><p>An AI running in a sealed enclave reads it and prints a fighter: a face, four stats, three moves named after your words. The first forge of a sentence is final.</p></li>
          <li><span className="loop-n display">03</span><div className="loop-art loop-fight"><FighterPoster spec={{ name: 'Counselor Coo', title: '', look: '', cry: '', school: 'MIND', style: 'TACTICIAN', moves: [], stats: { power: 14, guard: 18, speed: 25, grit: 13 } }} portrait="/art/fighter-pigeon.webp" size="sm" tilt={-4} showSentence={false} /><FighterPoster spec={{ name: 'Granny Purl', title: '', look: '', cry: '', school: 'IRON', style: 'COUNTERPUNCHER', moves: [], stats: { power: 10, guard: 25, speed: 10, grit: 25 } }} portrait="/art/fighter-grandma.webp" size="sm" tilt={4} showSentence={false} /></div><h3 className="display">Fight</h3><p>Best of three, refereed by the contract. A draw keeps the champion. Rematch in one tap.</p></li>
          <li><span className="loop-n display">04</span><div className="loop-art"><img src="/art/belt-midnight.webp" alt="" /></div><h3 className="display">Hold the belt</h3><p>Win and every challenger pays you, even the one who beats you. Hold it when the bell rings and you take the purse.</p></li>
        </ol>
      </section>

      <section id="money" className="land-sec money">
        <h2 className="display print sec-title">Where the money goes</h2>
        <p className="sec-sub">No token, no emissions, no faucet. Closed seasons, funded up front. The champion is paid for being the target.</p>
        <div className="money-grid">
          <div className="money-card panel">
            <span className="eyebrow">Every challenge · {near('50000000000000000000000')} NEAR toll · what's left after the forge and storage</span>
            <div className="split-bar" role="img" aria-label="Split of the toll after the forge fee and storage">
              <span style={{ flexGrow: 60 }} className="sb-champ">Champion 60%</span>
              <span style={{ flexGrow: 25 }} className="sb-prom">Promoter 25%</span>
              <span style={{ flexGrow: 10 }} className="sb-pot">Pot</span>
              <span style={{ flexGrow: 5 }} className="sb-house">House</span>
            </div>
            <ul className="money-list">
              <li>First <b>0.01 NEAR</b> pays the forge (the AI compile and its delivery, at cost), then the bytes the bout keeps on chain: more for a brand-new fighter, never more than half of what's left.</li>
              <li><b>60%</b> of the rest to the champion's holder, win or lose: they are the target.</li>
              <li><b>25%</b> to the promoter who funded the purse and wrote the opener.</li>
              <li><b>10%</b> into the season side-pot, paid at the bell. <b>5%</b> to the house.</li>
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
        <h3 className="display stack-sub">Beyond NEAR</h3>
        <div className="stack">
          {BEYOND.map((s) => (
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
            <li>The live game runs in relayer mode: OutLayer does not return our compile runs on testnet yet, so a listed relayer delivers NEAR AI's signed answer, the API key sits with our backend and the fight seed comes from the block. The contract checks the answer the same way; the tale of the tape shows the live mode.</li>
            <li>The model and rulebook are public, so anyone can search for strong sentences offline, bots included. The season's arena rule stays sealed only until the first bout (a referee on chain can't fight under a secret rule), so it blunts pre-season search; the defence-weighted purse and the per-account cap blunt the rest. None of it stops search outright.</li>
            <li>The contract checks each AI signature against an allowlist set by the owner and changed only behind a public timelock. The contract does not verify NEAR AI's hardware quote itself; <code>scripts/verify-attestation.mjs</code> does (Intel TDX quote, GPU evidence, booted code) and confirms the attested signer is the one on the allowlist.</li>
            <li>The promoter's Base wallet is pre-funded with test ETH. Its NEAR income is not converted into purses on testnet; that would need a mainnet swap route.</li>
            <li>A title shot bought on Base is booked on NEAR by our backend: nothing on chain ties the Base payment to the NEAR challenge.</li>
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
