import { useMemo } from 'react'
import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { Counter, Hash, TapeRow } from '../components/Tape'
import { useAsync, useGame } from '../game/context'
import { Api } from '../game/nearApi'
import { baseAddrUrl, NEARBLOCKS } from '../game/chain/config'
import { eth, near, shortHex } from '../lib/format'
import './pages.css'
import './proof.css'

const REPO = 'https://github.com/joshvajeskins/title-shot'
/** sha256 of contract/res/titleshot.wasm at the commit this site was built from. */
const BUILT_WASM_SHA = '843869206ec5c38ef8f69e2fb2bbf56a76c2f0b71b5cdd8cebdb2908f2f88333'
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function Proof() {
  const { client } = useGame()
  const api = useMemo(() => new Api(), [])
  const proof = useAsync(() => api.proof(), [api])
  const state = useAsync(() => api.stateFull(), [api])
  const p = proof.data
  const s = state.data
  const belts = s?.belts ?? []
  const bouts = belts.reduce((a, b) => a + (b.season.challenges ?? 0), 0)
  const vance = s?.wallets.find((w) => w.role === 'promoter')
  const loading = proof.loading || state.loading
  const err = proof.error ?? state.error

  return (
    <div className="page pages proof">
      <header className="page-head">
        <div>
          <span className="eyebrow">Tale of the tape</span>
          <h1 className="display print page-title">Read it off the chain</h1>
          <p className="page-sub">Every value on this page is read live from NEAR testnet and Base Sepolia{p ? `, as of ${clock(p.at)}` : ''}. Nothing here is typed in by us.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { proof.reload(); state.reload() }} disabled={loading}>
          <Icon name="refresh" size={14} /> {loading ? 'Reading…' : 'Read again'}
        </button>
      </header>

      {client.mode === 'mock' ? <p className="tape-banner">Demo build: the proof page reads the live testnet deployment, not this simulated chain.</p> : null}
      {err && !p ? (
        <div className="state-box"><span className="serif-i">The chain did not answer.</span><p>{err}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => proof.reload()}>Try again</button></div>
      ) : null}
      {loading && !p ? <div className="skeleton" style={{ height: 420 }} /> : null}

      {p ? (
        <>
          <section className="tape-counters">
            <Counter n={belts.length} label="belts on the line" />
            <Counter n={bouts} label="challenges this season" />
            <Counter n={s?.payouts.length ?? 0} label="purse payouts created" />
            <Counter n={`${p.caps.used}`} label={`AI compiles paid (cap ${p.caps.total})`} />
          </section>

          <section className="tape-sec">
            <h2 className="display sec-h">The referee</h2>
            <ol className="tape">
              <TapeRow label="Contract" verdict="info">
                <Hash value={p.contract} href={`${NEARBLOCKS}/address/${p.contract}`} />
              </TapeRow>
              <TapeRow label="Deployed code" verdict={p.codeHash?.hex === BUILT_WASM_SHA ? 'pass' : 'warn'}
                note={p.codeHash?.hex === BUILT_WASM_SHA ? <>Equals sha256 of <a href={`${REPO}/blob/main/contract/res/titleshot.wasm`} target="_blank" rel="noreferrer">contract/res/titleshot.wasm</a> in the repo. Run <code>shasum -a 256 contract/res/titleshot.wasm</code> to check.</> : 'Differs from the wasm this site was built with.'}>
                <Hash value={p.codeHash?.hex ?? 'unreadable'} />
              </TapeRow>
              <TapeRow label="AI model" verdict="info" note="Runs inside a GPU enclave on NEAR AI Cloud and signs every response.">
                <code className="mono">{p.model}</code> <span className="tape-dim">· {p.signatureKind}</span>
              </TapeRow>
              <TapeRow label="AI signer allowlist" verdict={p.allowlist.length ? 'pass' : 'fail'}
                note={<>A compile counts only if its signature recovers to one of these addresses. Changes wait {Math.round(p.allowlistDelaySec / 60)} min in public. <a href={`${REPO}/blob/main/docs/ATTESTATION.md`} target="_blank" rel="noreferrer">Why this is NEAR AI's enclave key</a>.</>}>
                {p.allowlist.map((a) => <Hash key={a} value={a} />)}
              </TapeRow>
              <TapeRow label="Request bytes" verdict={p.request.matchesSite ? 'pass' : 'fail'}
                note={p.request.matchesSite ? "The contract rebuilds the exact request from the public rulebook and your sentence. This site's rulebook builds the same bytes." : "This site's rulebook does not build the bytes the contract checks."}>
                <span className="tape-dim">prefix</span> <code className="mono">{shortHex(p.request.prefixSha256, 8)}</code> <span className="tape-dim">suffix</span> <code className="mono">{shortHex(p.request.suffixSha256, 8)}</code>
              </TapeRow>
              <TapeRow label="Forge" verdict={p.forgeMode === 'outlayer' ? 'pass' : 'warn'} note={forgeNote(p.forgeMode, p.pending)}>
                <code className="mono">{p.forgeMode}</code>{p.relayers.length && p.forgeMode === 'relayer' ? <span className="tape-dim"> · {p.relayers.join(', ')}</span> : null}
              </TapeRow>
              <TapeRow label="Deploy gates" verdict={p.gates.ready ? 'pass' : 'fail'} note={p.gates.failing.length ? p.gates.failing.map((g) => `${g.gate}: ${g.why}`).join('; ') : 'Every gate that blocks challenges is met.'}>
                {p.gates.ready ? 'Ready' : 'Not ready'}
              </TapeRow>
              <TapeRow label="Players covered" verdict={p.solvency.players_covered ? 'pass' : 'fail'}
                note={`The contract holds ${near(p.solvency.balance, 2)} NEAR against ${near(p.solvency.owed, 2)} NEAR owed to players and ${near(p.solvency.storage_cost, 2)} NEAR of storage.`}>
                {p.solvency.players_covered ? 'Every player balance is backed' : `Short by ${near(p.solvency.deficit, 3)} NEAR`}
              </TapeRow>
              <TapeRow label="AI compile cap" verdict={p.caps.open ? 'pass' : 'warn'} note="Counted by the contract before any toll moves; a closed forge refuses new sentences with E_FORGE_CLOSED.">
                {p.caps.today} / {p.caps.daily} today · {p.caps.used} / {p.caps.total} in total
              </TapeRow>
            </ol>
          </section>

          <section className="tape-sec">
            <h2 className="display sec-h">The money on Base</h2>
            <ol className="tape">
              {vance?.baseAddress ? (
                <TapeRow label="Promoter wallet" verdict="info" note="Velvet Vance's Base address is derived from its NEAR account by Chain Signatures. No private key for it exists anywhere.">
                  <Hash value={vance.baseAddress} href={baseAddrUrl(vance.baseAddress)} /> <span className="tape-dim">{eth(vance.baseWei ?? '0')} ETH</span>
                </TapeRow>
              ) : null}
              {belts.map((b) => (
                <TapeRow key={b.id} label={b.name} verdict={b.season.purse.address ? 'info' : 'warn'} note={`Season ${b.season.id} purse. Only close_season can move it, and only to the winners.`}>
                  {b.season.purse.address ? <Hash value={b.season.purse.address} href={baseAddrUrl(b.season.purse.address)} /> : 'Purse address not set yet'} <span className="tape-dim">{eth(b.season.purse.amountWei)} ETH</span>
                </TapeRow>
              ))}
              {(s?.payouts ?? []).slice(0, 6).map((po) => (
                <TapeRow key={po.id} label={`Payout #${po.id}`} verdict={po.status === 'mined' ? 'pass' : 'info'} note={`${po.payee} · belt ${po.beltId}, season ${po.seasonId}`}>
                  {eth(po.amountWei)} ETH → {po.to ? shortHex(po.to) : 'no address yet'} · {po.explorer ? <a href={po.explorer} target="_blank" rel="noreferrer">{po.status}</a> : po.status}
                </TapeRow>
              ))}
              {!belts.length ? <li className="tape-empty">No season is open yet. Purses appear here when the promoter opens one.</li> : null}
            </ol>
          </section>

          <section className="tape-sec tape-links">
            <Link href="/play/book" className="btn btn-ghost btn-sm">Every bout, with its transactions <Icon name="arrow" size={14} /></Link>
            <a className="btn btn-ghost btn-sm" href={`${REPO}/blob/main/docs/CHEAT-RESULTS.md`} target="_blank" rel="noreferrer">Cheats the contract refused <Icon name="external" size={13} /></a>
            <a className="btn btn-ghost btn-sm" href={REPO} target="_blank" rel="noreferrer">Source and tests <Icon name="external" size={13} /></a>
          </section>
        </>
      ) : null}
    </div>
  )
}

function forgeNote(mode: string, pending: { forgeMode: string | null; activatesAt: number } | null) {
  const staged = pending?.forgeMode && pending.forgeMode !== mode ? ` A switch to ${pending.forgeMode} is staged in public and can apply from ${clock(pending.activatesAt)}.` : ''
  if (mode === 'outlayer') return `OutLayer runs the compile inside Intel TDX with the API key sealed to this contract, and draws the fight seed from its VRF.${staged}`
  return `Our backend asks NEAR AI to compile and a listed relayer submits the signed answer. The contract still rebuilds the request and checks NEAR AI's signature, so a relayer cannot change a fighter, only withhold one. The fight seed comes from the block.${staged}`
}
