// /play/me "My corner": the signed-in account's dossier (belts held, fighters, bouts, earnings), read live from the contract.
// /play/me?account=<id> opens any account's corner read-only.
import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { useAsync, useGame } from '../game/context'
import { bustCorner, loadCorner } from '../game/corner/load'
import { navigate, useHref } from '../lib/router'
import { Header, type Viewer } from './me/Header'
import { Belts } from './me/Belts'
import { Fighters } from './me/Fighters'
import { Bouts } from './me/Bouts'
import { Earnings } from './me/Earnings'
import { CornerSkeleton } from './me/parts'
import './pages.css'
import './me/me.css'

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
export const validAccount = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim().toLowerCase()
  return ACCOUNT_ID.test(t) ? t : null
}

export function MyCorner() {
  const { client, account, ready, refreshAccount } = useGame()
  useHref() // the ?account= query can change without the path
  const asked = new URLSearchParams(location.search).get('account')
  const visit = validAccount(asked)
  const target = visit ?? account?.id ?? null
  const viewer: Viewer = account && target === account.id ? { kind: 'self', wallet: account.kind === 'wallet' } : { kind: 'visitor' }
  const corner = useAsync(() => (target ? loadCorner(client, target) : Promise.resolve(null)), [client, target])
  const refresh = () => { bustCorner(); corner.reload(); if (account) void refreshAccount() }
  if (!ready && !visit) return <div className="page mc"><CornerSkeleton /></div>
  if (!target) return <div className="page mc"><Spectator badLookup={asked !== null} /></div>
  const data = corner.data && corner.data.account === target ? corner.data : null
  const self = viewer.kind === 'self'
  return (
    <div className="page mc">
      {asked !== null && !visit && <p className="mc-msg is-bad" role="alert">“{asked}” is not a NEAR account id, so this is your own corner.</p>}
      {!data && corner.error && (
        <div className="mc-empty" role="alert">
          <span className="serif-i">The corner file would not open.</span>
          <p>{corner.error}</p>
          <button className="btn btn-ghost btn-sm" onClick={refresh}><Icon name="refresh" size={15} /> Try again</button>
        </div>
      )}
      {!data && !corner.error && <CornerSkeleton />}
      {data && (
        <>
          <Header data={data} viewer={viewer} onChanged={refresh} />
          {corner.error && <p className="mc-msg is-bad" role="alert">Could not refresh: {corner.error} <button className="mc-link" onClick={refresh}>Try again</button></p>}
          <Belts held={data.held} self={self} />
          <Fighters fighters={data.fighters} self={self} />
          <div className="mc-cols">
            <Bouts bouts={data.bouts} self={self} />
            <Earnings data={data} self={self} onChanged={refresh} />
          </div>
          <p className="mc-note">
            Read live from <b>ring.titleshot.testnet</b>: every belt's fights (get_fights), the belt tokens you own (nft_tokens_for_owner), your fighters
            (get_fighter), the seasons you fought in (get_season, get_payouts), your balance and payout address. <button className="mc-link" onClick={refresh} disabled={corner.loading}><Icon name="refresh" size={11} /> {corner.loading ? 'Reading…' : 'Read again'}</button>
          </p>
        </>
      )}
    </div>
  )
}

function Spectator({ badLookup }: { badLookup: boolean }) {
  const [id, setId] = useState('')
  const [bad, setBad] = useState(badLookup)
  const look = (e: FormEvent) => {
    e.preventDefault()
    const a = validAccount(id)
    if (!a) { setBad(true); return }
    navigate(`/play/me?account=${encodeURIComponent(a)}`)
  }
  return (
    <div className="mc-file mc-spect paper">
      <span className="mc-file-tab">Corner file · <b>no one signed in</b></span>
      <span className="eyebrow">My corner</span>
      <h1 className="display mc-name">No file open</h1>
      <p>Your corner keeps your belts, the fighters you wrote, every bout you fought and what it paid you, read straight from the NEAR contract. Get in the ring to open yours.</p>
      <div className="mc-actions">
        <Link href="/enter?next=%2Fplay%2Fme" className="btn btn-red">Connect my NEAR wallet <Icon name="arrow" /></Link>
        <Link href="/enter?next=%2Fplay%2Fme" className="btn btn-ghost">Open the judge demo</Link>
      </div>
      <form className="mc-look" onSubmit={look}>
        <label>Or read any corner
          <input value={id} onChange={(e) => { setId(e.target.value); setBad(false) }} placeholder="name.testnet" spellCheck={false} autoCapitalize="none" autoComplete="off" aria-invalid={bad} />
        </label>
        <button className="btn btn-ghost btn-sm" type="submit">Open file</button>
      </form>
      {bad && <p className="mc-msg is-bad" role="alert" style={{ color: 'var(--red-deep)' }}>That is not a NEAR account id (for example otto-ink.testnet).</p>}
    </div>
  )
}
