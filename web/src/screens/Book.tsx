import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { useAsync, useGame } from '../game/context'
import { ago, near, shortAccount, shortHex } from '../lib/format'
import './pages.css'

export function Book() {
  const { client, account } = useGame()
  const [belt, setBelt] = useState<string>('all')
  const [mine, setMine] = useState(false)
  const belts = useAsync(() => client.belts(), [client])
  const hist = useAsync(() => client.history(belt === 'all' ? undefined : belt), [client, belt])
  const rows = (hist.data ?? []).filter((r) => !mine || r.challenger === account?.id || r.champion === account?.id)
  // Title shots bought on Base over x402 (functions/api/boxoffice/recent): the corner account → who paid on Base.
  const base = useAsync(() => (client.mode === 'mock' ? Promise.resolve(new Map<string, string>()) : fetch('/api/boxoffice/recent')
    .then((r) => (r.ok ? r.json() : { bookings: [] }))
    .then((j: { bookings?: { guest: string; payer: string; payerName: string | null }[] }) => new Map((j.bookings ?? []).map((b) => [b.guest, b.payerName ?? shortHex(b.payer)] as const)))
    .catch(() => new Map<string, string>())), [client])
  const counts = { all: hist.data?.length ?? 0, won: (hist.data ?? []).filter((r) => r.winner === 1).length }
  return (
    <div className="page pages">
      <header className="page-head">
        <div>
          <span className="eyebrow">The book</span>
          <h1 className="display print page-title">Every bout, on the record</h1>
          <p className="page-sub">{counts.all} bouts so far · {counts.won} title changes. Open any bout to replay it and check its receipts.</p>
        </div>
      </header>
      <div className="filters">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={belt === 'all'} className={belt === 'all' ? 'is-on' : ''} onClick={() => setBelt('all')}>All belts</button>
          {(belts.data ?? []).map((b) => (
            <button key={b.id} role="tab" aria-selected={belt === b.id} className={belt === b.id ? 'is-on' : ''} onClick={() => setBelt(b.id)}>{b.name.replace('The ', '')}</button>
          ))}
        </div>
        {account && (
          <button className={`toggle ${mine ? 'is-on' : ''}`} onClick={() => setMine(!mine)} role="switch" aria-checked={mine}>
            <span className="toggle-knob" /> Only my bouts
          </button>
        )}
      </div>
      {hist.loading && <div className="skeleton" style={{ height: 280 }} />}
      {hist.error && <div className="state-box panel"><span className="serif-i">The book is stuck shut.</span><span>{hist.error}</span><button className="btn btn-ghost btn-sm" onClick={hist.reload}>Try again</button></div>}
      {!hist.loading && !hist.error && rows.length === 0 && (
        <div className="state-box panel">
          <span className="serif-i">No bouts here yet.</span>
          <span>{mine ? "You haven't taken a shot yet." : 'Be the first challenger of the season.'}</span>
          <Link href="/play" className="btn btn-red btn-sm">Pick a belt</Link>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="book">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/play/bout/${r.id}`} className="book-row">
                <span className={`book-result res-${r.winner}`}>{r.winner === 1 ? 'New champ' : r.winner === 2 ? 'Draw' : 'Defended'}</span>
                <span className="book-names"><b>{r.challengerName}</b> <i>vs</i> <b>{r.championName}</b></span>
                <span className="book-meta">{base.data?.get(r.challenger) ? <span className="book-chip">from Base · {base.data.get(r.challenger)}</span> : null}{shortAccount(r.challenger)} · {near(r.tollYocto)} NEAR toll · {ago(r.at)}</span>
                <Icon name="arrow" size={16} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
