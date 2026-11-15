import { useState } from 'react'
import { BaseName } from '../../components/BaseName'
import { Icon } from '../../components/Icon'
import { PayoutAddressDialog } from '../../components/PayoutAddress'
import { baseTxUrl } from '../../game/chain/config'
import type { CornerData } from '../../game/corner/load'
import { nearEarned, type MyPayout } from '../../game/corner/derive'
import { eth, near, plural } from '../../lib/format'
import { SecHead } from './parts'

const STATUS: Record<MyPayout['state'], { text: string; cls: string }> = {
  mined: { text: 'Paid on Base', cls: 'chip-blue' },
  signed: { text: 'Signed · not mined yet', cls: '' },
  signing: { text: 'MPC signing', cls: '' },
  unsigned: { text: 'Queued for signing', cls: '' },
  claimable: { text: 'Unclaimed', cls: 'chip-gold' },
  reverted: { text: 'Reverted on Base', cls: 'chip-red' },
}

export function Earnings({ data, self, onChanged }: { data: CornerData; self: boolean; onChanged: () => void }) {
  const e = data.earnings
  const [claiming, setClaiming] = useState<{ payoutId: number; amountWei: string } | null>(null)
  const beltName = (id: number) => data.belts.find((b) => b.numericId === id)?.name.replace('The ', '') ?? `Belt ${id}`
  const unclaimed = data.payouts.filter((p) => p.state === 'claimable')
  return (
    <section className="mc-sec" aria-labelledby="mc-earn">
      <SecHead n="04" id="mc-earn" title="Earnings" aside="read from the contract" />
      <div className="mc-earn paper">
        <div className="mc-earn-row">
          <b>Champion's share</b>
          <span>{e.championBouts ? `60% of the toll after fees, from ${plural(e.championBouts, 'challenge')} against a belt ${self ? 'you' : 'this corner'} held` : 'Paid to the holder of a belt for every challenge, win or lose'}</span>
          <span className="num">+{near(e.championYocto, 4)} NEAR</span>
        </div>
        <div className="mc-earn-row">
          <b>Season side-pots</b>
          <span>{e.sidePotSeasons ? `Credited at the bell of ${plural(e.sidePotSeasons, 'season')} ${self ? 'you' : 'this corner'} closed holding the belt` : 'Credited to whoever holds the belt when the bell rings'}</span>
          <span className="num">+{near(e.sidePotYocto, 4)} NEAR</span>
        </div>
        <div className="mc-earn-row is-total">
          <b>NEAR earned</b>
          <span>Into the game balance above. Exact: summed from each bout's on-chain split and each season's side-pot.</span>
          <span className="num">{near(nearEarned(e), 4)}</span>
        </div>
        <div className="mc-earn-row is-paid">
          <b>Tolls paid</b>
          <span>{e.challenges ? `${plural(e.challenges, 'title shot')}: each bout's split, storage and forge fee` : 'No title shots paid yet'}</span>
          <span className="num">−{near(e.tollsPaidYocto, 4)} NEAR</span>
        </div>
      </div>

      <h3 className="display" style={{ margin: '10px 0 0', fontSize: 24 }}>Purse shares on Base Sepolia</h3>
      {data.payouts.length === 0 ? (
        <p className="mc-note">No purse shares yet. At each bell the contract pays half the season's purse to the final holder and splits the rest by defences, signed through Chain Signatures and sent on Base Sepolia.</p>
      ) : (
        <ul className="mc-purses">
          {data.payouts.map((p) => {
            const st = STATUS[p.state]
            return (
              <li key={p.id} className={`mc-purse ${p.state === 'claimable' ? 'is-claim' : ''}`}>
                <div className="mc-purse-who">
                  <b>{beltName(p.beltId)} · season {p.seasonId}</b>
                  <small>Payout #{p.id} · {p.share === 'holder' ? 'final holder' : 'defences'}{p.to ? <> · to <BaseName address={p.to} /></> : ' · no address on file at the bell'}</small>
                </div>
                <span className="mc-purse-amt num">{eth(p.amountWei, 5)} ETH</span>
                <div className="mc-purse-tx">
                  <span className={`chip ${st.cls}`}>{st.text}</span>
                  {p.txHash && <a className="mc-link" href={baseTxUrl(p.txHash)} target="_blank" rel="noreferrer">Basescan <Icon name="external" size={10} /></a>}
                  {p.state === 'claimable' && self && <button className="btn btn-gold btn-sm" onClick={() => setClaiming({ payoutId: p.id, amountWei: p.amountWei.toString() })}>Claim {eth(p.amountWei, 4)} ETH</button>}
                  {p.state === 'claimable' && !self && <span className="mc-note">Only this account can claim it.</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {unclaimed.length > 0 && self && <p className="mc-note">An unclaimed share was set aside because your corner had no Base address at the bell. Claiming names the address once; the contract then signs the payout at the next tick (about 5 minutes).</p>}
      <p className="mc-note">Statuses come from the contract and Base itself: a signed payout's transaction hash is keccak256 of the raw transaction the contract stored, and "Paid on Base" means Base returned a successful receipt for it.</p>
      {claiming && <PayoutAddressDialog claim={claiming} onClose={() => { setClaiming(null); onChanged() }} />}
    </section>
  )
}
