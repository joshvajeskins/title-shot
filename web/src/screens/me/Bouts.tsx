import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Link } from '../../components/Link'
import type { CornerBout } from '../../game/corner/load'
import type { Outcome } from '../../game/corner/derive'
import { ago, near, shortAccount } from '../../lib/format'
import { Empty, SecHead } from './parts'

const LABEL: Record<Outcome, { text: string; cls: string }> = {
  took: { text: 'Took the belt', cls: 'res-1' },
  lost: { text: 'Lost', cls: 'res-lost' },
  draw: { text: 'Draw', cls: 'res-2' },
  defended: { text: 'Defended', cls: 'res-0' },
  dethroned: { text: 'Lost the belt', cls: 'res-dethroned' },
}
const PAGE = 12

export function Bouts({ bouts, self }: { bouts: CornerBout[]; self: boolean }) {
  const [all, setAll] = useState(false)
  const shown = all ? bouts : bouts.slice(0, PAGE)
  return (
    <section className="mc-sec" aria-labelledby="mc-bouts">
      <SecHead n="03" id="mc-bouts" title={self ? 'Your bouts' : 'Bouts'} aside={bouts.length ? `${bouts.length} on the record` : undefined} />
      {bouts.length === 0 ? (
        <Empty title={self ? 'No bouts on your record yet.' : 'No bouts on this record.'} body="Every challenge you pay for, and every challenge against a belt you hold, lands here with its result, its toll and what it paid you.">
          <Link href="/play" className="btn btn-red btn-sm">Pick a belt <Icon name="arrow" size={15} /></Link>
        </Empty>
      ) : (
        <>
          <ul className="mc-bouts">
            {shown.map((b) => {
              const l = LABEL[b.outcome]
              return (
                <li key={b.id}>
                  <Link href={`/play/bout/${b.id}`} className="mc-bout">
                    <span className={`book-result ${l.cls}`}>{l.text}</span>
                    <span className="mc-bout-names"><b>{b.myName}</b> <i>vs</i> <b>{b.oppName}</b></span>
                    <span className="mc-bout-money num">
                      {b.role === 'holder'
                        ? <><span className="mc-plus">+{near(b.receivedYocto, 4)}</span><small>champion's share</small></>
                        : <><span className="mc-minus">−{near(b.tollYocto, 3)}</span><small>toll paid</small></>}
                    </span>
                    <span className="mc-bout-meta">#{b.id} · {b.beltName.replace('The ', '')} · s{b.seasonId} · {b.role === 'holder' ? 'you held the belt' : 'you challenged'} {shortAccount(b.opponent)} · {near(b.tollYocto, 3)} NEAR toll · {ago(b.at)}</span>
                    <Icon name="arrow" size={16} />
                  </Link>
                </li>
              )
            })}
          </ul>
          {bouts.length > PAGE && <button className="btn btn-ghost btn-sm mc-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${bouts.length}`}</button>}
        </>
      )}
    </section>
  )
}
