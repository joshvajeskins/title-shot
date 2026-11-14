import type { CSSProperties } from 'react'
import { near } from '../../lib/format'

const SPLIT = [
  { k: 'Champion', v: 60, c: 'sb-champ', note: 'the target is paid, win or lose' },
  { k: 'Promoter', v: 25, c: 'sb-prom', note: 'funded the purse, wrote the opener' },
  { k: 'Side-pot', v: 10, c: 'sb-pot', note: 'paid at the bell' },
  { k: 'House', v: 5, c: 'sb-house', note: '' },
]

/** Where the money goes, printed as one purse bill: the toll split on the left, the bell on the right. */
export function Money() {
  return (
    <section id="money" className="land-sec">
      <header className="sec-head" data-reveal>
        <span className="sec-kicker">The money</span>
        <h2 className="display print sec-title">Where the money goes</h2>
      </header>
      <div className="bill bill-wide" data-reveal style={{ '--d': '60ms' } as CSSProperties}>
        <div className="bill-in torn purse">
          <div className="purse-toll">
            <span className="bill-label">Every challenge · {near('50000000000000000000000')} NEAR toll</span>
            <p className="purse-lede">The first 0.01 NEAR pays the AI forge at cost. The rest splits four ways:</p>
            <div className="split-bar" role="img" aria-label="Champion 60%, promoter 25%, side-pot 10%, house 5%">
              {SPLIT.map((s) => <span key={s.k} className={s.c} style={{ flexGrow: s.v }}>{s.v >= 10 ? `${s.v}%` : ''}</span>)}
            </div>
            <ul className="split-key">
              {SPLIT.map((s) => <li key={s.k}><i className={s.c} /><b>{s.k} {s.v}%</b>{s.note ? <span>{s.note}</span> : null}</li>)}
            </ul>
          </div>
          <div className="purse-bell">
            <span className="bill-label">At the bell · the purse</span>
            <div className="bell-split">
              <div><b className="display">50%</b><span>to whoever holds the belt</span></div>
              <div><b className="display">50%</b><span>split by defences, capped at 25% per account</span></div>
            </div>
            <p className="purse-note">No token, no emissions, no faucet. Seasons are funded up front, so a last-minute snipe takes half, never all.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
