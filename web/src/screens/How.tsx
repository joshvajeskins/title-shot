import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { useGame } from '../game/context'
import './pages.css'

const FLOW: { who: string; what: string; detail: string }[] = [
  { who: 'You', what: 'challenge(belt, sentence)', detail: 'Signed by a session key that can only call this method. The 0.1 NEAR toll comes out of your fight balance. No wallet popup.' },
  { who: 'Contract', what: 'request_execution → OutLayer', detail: 'Pays the forge fee and asks OutLayer to run forge.wasm once for this challenge id.' },
  { who: 'OutLayer TEE', what: 'forge.wasm → NEAR AI Cloud', detail: 'Inside Intel TDX, with the API key as a sealed secret: one non-streamed call to a model running in a GPU TEE, plus a VRF seed.' },
  { who: 'NEAR AI Cloud', what: 'signed compile', detail: 'Returns the fighter JSON and an ECDSA signature over sha256(request) and sha256(response).' },
  { who: 'Contract', what: 'on_forged: verify, normalize, fight', detail: 'Rebuilds the request bytes from the public rulebook and your sentence, ecrecovers the AI signer against the allowlist, enforces the 100-point budget, runs best-of-three, splits the toll.' },
  { who: 'Your browser', what: 'replay', detail: 'Runs the same Rust referee compiled to WebAssembly and checks its state hash equals the one the contract stored.' },
  { who: 'Anyone', what: 'close_season → Chain Signatures', detail: 'At the bell the contract asks the MPC network to sign Base Sepolia transfers from the purse address it controls, to the winners only.' },
]

export function How() {
  const { client } = useGame()
  return (
    <div className="page pages">
      <header className="page-head">
        <div>
          <span className="eyebrow">How it works</span>
          <h1 className="display print page-title">One challenge, end to end</h1>
          <p className="page-sub">Every arrow below is a transaction or a signature you can look up. If any step fails, your toll comes back minus the forge fee.</p>
        </div>
      </header>
      <ol className="flow">
        {FLOW.map((f, i) => (
          <li key={i} className="flow-step panel">
            <span className="flow-n display">{String(i + 1).padStart(2, '0')}</span>
            <div><span className="eyebrow">{f.who}</span><code>{f.what}</code><p>{f.detail}</p></div>
          </li>
        ))}
      </ol>
      <section className="how-grid">
        <article className="panel how-card">
          <h2 className="display">The rulebook</h2>
          <p>Six schools (Blaze, Tide, Volt, Iron, Mind, Wild), each strong against two and weak against two. Four styles decide how a fighter picks its moves. Every fighter gets 100 points split between three moves and four stats; strong moves cost more. The prompt, the move library and the JSON schema are public and hashed into the contract.</p>
        </article>
        <article className="panel how-card">
          <h2 className="display">The sealed rule</h2>
          <p>Each season has an arena rule (for example "Padded Ring: stun chances halved"). It is drawn from the first bout's VRF seed, so nobody, the promoter included, knows it when the opening champion is written. After the first bout it is public.</p>
        </article>
        <article className="panel how-card">
          <h2 className="display">One sentence, one fighter</h2>
          <p>The first paid forge of a sentence is final and stored on chain. Anyone who challenges with the same sentence later gets the same fighter, so nobody can re-roll a compile they did not like.</p>
        </article>
        <article className="panel how-card">
          <h2 className="display">Check it yourself</h2>
          <p>Every bout page lists the VRF seed, the referee hash and the transactions. {client.mode === 'mock' ? 'This build is running in demo mode with a simulated chain.' : 'The contract, the OutLayer project and the purse addresses are linked from the Book.'}</p>
          <Link href="/play/book" className="btn btn-ghost btn-sm">Open the Book <Icon name="arrow" size={14} /></Link>
        </article>
      </section>
    </div>
  )
}
