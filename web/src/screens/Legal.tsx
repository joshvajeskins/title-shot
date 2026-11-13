import { Link, Wordmark } from '../components/Link'
import './pages.css'

const TERMS = [
  ['A game on test networks', 'TITLE SHOT runs on NEAR testnet and Base Sepolia. Test NEAR and test ETH have no cash value and cannot be redeemed for anything.'],
  ['Your account', 'A fighter account is a NEAR testnet account whose keys live in your browser. If you clear your browser storage without exporting the key, the account is gone. We cannot recover it.'],
  ['Sentences', 'Sentences you forge are public and permanent on chain. Do not write personal data. The compiler refuses hateful, sexual or real-person content; refused sentences are refunded minus the forge fee.'],
  ['No guarantees', 'The game is a hackathon prototype provided as is. Contracts, enclaves and networks can fail; the refund paths are described in How it works.'],
]
const PRIVACY = [
  ['What we store', 'Nothing about you off chain beyond a short-lived rate-limit record of your IP address when you create a guest account or spar.'],
  ['On chain', 'Your account id, your sentences, your bouts and your balances are public on NEAR testnet, like every transaction.'],
  ['Third parties', 'Sentences are sent to NEAR AI Cloud to compile (inside a TEE) and fighter battle cries to ElevenLabs for speech. Fonts load from Google Fonts.'],
  ['Cookies', 'None. Sound and session settings live in your browser storage.'],
]

export function Legal({ kind }: { kind: 'terms' | 'privacy' }) {
  const rows = kind === 'terms' ? TERMS : PRIVACY
  return (
    <div className="legal">
      <header><Link href="/"><Wordmark size={26} /></Link><Link href={kind === 'terms' ? '/privacy' : '/terms'} className="eyebrow">{kind === 'terms' ? 'Privacy' : 'Terms'}</Link></header>
      <h1 className="display print">{kind === 'terms' ? 'Terms' : 'Privacy'}</h1>
      <p className="legal-date">Updated 14 November 2026</p>
      {rows.map(([h, p]) => <section key={h}><h2 className="display">{h}</h2><p>{p}</p></section>)}
      <Link href="/play" className="btn btn-ghost btn-sm">Back to the belts</Link>
    </div>
  )
}
