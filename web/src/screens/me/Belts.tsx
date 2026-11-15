import { useNow } from '../../components/BeltCard'
import { Icon } from '../../components/Icon'
import { Link } from '../../components/Link'
import { championShare, type ChainBelt } from '../../game/chain/views'
import { countdown, near } from '../../lib/format'
import { Empty, SecHead } from './parts'

const reign = (ms: number): string => {
  const h = Math.max(0, ms) / 3600e3
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${Math.floor(h / 24)}d`
}

export function Belts({ held, self }: { held: ChainBelt[]; self: boolean }) {
  const now = useNow()
  return (
    <section className="mc-sec" aria-labelledby="mc-belts">
      <SecHead n="01" id="mc-belts" title={self ? 'Belts you hold' : 'Belts held'} aside={held.length ? `${held.length} held · NEP-171 tokens` : 'NEP-171 tokens'} />
      {held.length === 0 ? (
        <Empty title={self ? 'You hold no belt yet. Take your shot.' : 'This corner holds no belt.'} body="A belt is a token on the contract. Whoever holds it is paid the champion's share of every challenge, win or lose, and takes the purse at the bell.">
          <Link href="/play" className="btn btn-red btn-sm">See the belts <Icon name="arrow" size={15} /></Link>
        </Empty>
      ) : (
        <div className="mc-belts">
          {held.map((b) => {
            const left = b.season.endsAt - now
            return (
              <article key={b.id} className={`mc-belt panel accent-${b.accent}`}>
                <img src={b.art} alt="" draggable={false} />
                <div>
                  <span className="eyebrow">Season {b.season.id} · {b.champion.spec.name}</span>
                  <h3 className="display print">{b.name}</h3>
                </div>
                <dl>
                  <div><dt>Reign</dt><dd className="num">{reign(now - b.reignSince)}</dd></div>
                  <div><dt>Defences</dt><dd className="num">{b.defences}</dd></div>
                  <div><dt>{self ? 'You earn' : 'Holder earns'} per challenge</dt><dd className="num">≈ {near(championShare(BigInt(b.tollYocto), BigInt(b.forgeFeeYocto)), 4)} <small>NEAR · estimate</small></dd></div>
                  <div><dt>Next bell</dt><dd className="num">{left > 0 ? countdown(left) : 'ringing · settling'}</dd></div>
                </dl>
                <p className="mc-note">60% of each {near(b.tollYocto, 2)} NEAR toll after the forge fee and the bout's storage. Storage is measured per bout, so the figure is the contract's own estimate.</p>
                <Link href={`/play/belt/${b.id}`} className="mc-link">Open the belt <Icon name="arrow" size={11} /></Link>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
