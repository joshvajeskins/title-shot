// Fair by construction and what we don't claim: moved here from the landing so the claims sit beside the live readout.
const STACK = [
  { k: 'NEAR AI Cloud', role: 'The compiler', d: 'A model running inside a TEE turns your sentence into stats and moves under a public rulebook, and signs its answer. The contract checks that signature with ecrecover.' },
  { k: 'OutLayer', role: 'The sealed forge', d: 'forge.wasm is built for OutLayer’s Intel TDX workers, with the API key sealed to the game contract and the fight seed from a VRF. On testnet OutLayer does not return our compile runs yet, so a listed relayer delivers NEAR AI’s signed answer instead. The contract checks it the same way, and the Forge row above shows which mode is live.' },
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

const LIMITS = [
  'The live game runs in relayer mode: OutLayer does not return our compile runs on testnet yet, so a listed relayer delivers NEAR AI’s signed answer, the API key sits with our backend and the fight seed comes from the block. The contract checks the answer the same way.',
  'The model and rulebook are public, so anyone can search for strong sentences offline, bots included. The season’s arena rule stays sealed only until the first bout (a referee on chain can’t fight under a secret rule), so it blunts pre-season search; the defence-weighted purse and the per-account cap blunt the rest. None of it stops search outright.',
  <>The contract checks each AI signature against an allowlist set by the owner and changed only behind a public timelock. It does not verify NEAR AI’s hardware quote itself; <code>scripts/verify-attestation.mjs</code> does (Intel TDX quote, GPU evidence, booted code) and confirms the attested signer is the one on the allowlist.</>,
  'The promoter’s Base wallet is pre-funded with test ETH. Its NEAR income is not converted into purses on testnet; that would need a mainnet swap route.',
  'A title shot bought on Base is booked on NEAR by our backend: nothing on chain ties the Base payment to the NEAR challenge.',
  'This runs on NEAR testnet and Base Sepolia. Testnet tokens have no cash value.',
]

function Rows({ items }: { items: typeof STACK }) {
  return (
    <ol className="tape fair-tape">
      {items.map((s) => (
        <li key={s.k} className="tape-row v-info">
          <span className="tape-label">{s.k}</span>
          <div className="tape-value"><p className="fair-d">{s.d}</p></div>
          <span className="tape-verdict">{s.role}</span>
        </li>
      ))}
    </ol>
  )
}

export function ProofFair() {
  return (
    <>
      <section id="fair" className="tape-sec fair">
        <h2 className="display sec-h">Fair by construction</h2>
        <p className="fair-sub">Six pieces of NEAR, each doing one job you can check. Pull any one out and the game loses something you can name.</p>
        <Rows items={STACK} />
        <h3 className="display fair-h3">Beyond NEAR</h3>
        <Rows items={BEYOND} />
      </section>
      <section className="tape-sec fair">
        <h2 className="display sec-h">What we don’t claim</h2>
        <ol className="tape fair-limits">
          {LIMITS.map((l, i) => <li key={i}><span className="fair-n display">{String(i + 1).padStart(2, '0')}</span><p>{l}</p></li>)}
        </ol>
      </section>
    </>
  )
}
