import { Link } from '../../components/Link'
import type { Belt } from '../../game/types'
import { eth, plural } from '../../lib/format'

/** The live card, printed as a full-width fight bill across the bottom of the first screen. */
export function BeltBill({ belts, error }: { belts: Belt[] | null; error: string | null }) {
  return (
    <div className="bill-strip" data-state={belts ? 'live' : error ? 'error' : 'loading'}>
      <div className="bill-strip-in">
        <span className="bill-strip-head"><b>Tonight's card</b><span>live from NEAR testnet</span></span>
        {belts ? (
          <ul className="bill-belts">
            {belts.map((b) => (
              <li key={b.id}>
                <Link href={`/play/belt/${b.id}`} className="bill-belt">
                  <img src={b.art} alt="" />
                  <span className="bill-belt-txt">
                    <b className="display">{b.champion.spec.name}</b>
                    <span><span className="hide-sm">holds the </span>{b.name.replace('The ', '')}</span>
                    <span className="num">{plural(b.defences, 'defence')} · purse {eth(b.season.purse.amountWei)} ETH</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : error ? (
          <Link href="/play" className="bill-belts bill-msg">The card is posted in the ring. Open the belts →</Link>
        ) : (
          <ul className="bill-belts" aria-label="Reading the belts">
            {[0, 1, 2].map((i) => <li key={i} className="bill-belt bill-ghost"><i /><span><i /><i /></span></li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
