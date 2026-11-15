import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { PayoutAddressDialog } from '../components/PayoutAddress'
import type { Fight } from '../game/types'
import { near, shortHex } from '../lib/format'
import './result.css'

interface Props { fight: Fight; beltArt: string; beltName: string; onRematch: () => void; onRewrite: () => void; verified: boolean | null; viewer?: string | null }

export function Result({ fight, beltArt, beltName, onRematch, onRewrite, verified, viewer = null }: Props) {
  const won = fight.winner === 1
  // A shared bout link is opened by people who did not fight it: they get the result in the third person and their own
  // shot at the belt, not "The belt is yours" or a rematch with someone else's sentence.
  const mine = !!viewer && viewer === (fight.challengerAccount ?? fight.challenger.writer)
  const name = fight.challenger.spec.name
  const draw = fight.winner === 2
  const [copied, setCopied] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  useEffect(() => {
    void sound.music(null, 400)
    if (won) { sound.play('victory_sting'); setTimeout(() => sound.play('new_champ'), 600); sound.pick('crowd_roar', 2) }
    else if (draw) { sound.play('defeat_sting'); setTimeout(() => sound.play('draw'), 500) }
    else { sound.play('defeat_sting'); setTimeout(() => sound.play('holds'), 500); setTimeout(() => sound.play('kaching'), 1600) }
  }, [won, draw])
  const share = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* clipboard blocked */ }
  }
  const champ = fight.champion.spec.name
  return (
    <div className={`result ${won ? 'is-win' : draw ? 'is-draw' : 'is-loss'}`}>
      <div className="result-bg" aria-hidden="true" />
      <div className="result-hero">
        <div className="result-poster">
          <FighterPoster fighter={won ? fight.challenger : fight.champion} corner={won ? 'chall' : 'champ'} size="lg" tilt={won ? 2 : -2} />
          {won && <img className="result-belt" src={beltArt} alt="" />}
          <span className={`stamp result-stamp ${won ? 'stamp-gold' : ''}`}>{won ? 'New champion' : draw ? 'Draw' : 'Defended'}</span>
        </div>
        <div className="result-copy">
          <span className="eyebrow">{beltName}</span>
          <h1 className="display print result-h">{won ? (mine ? 'The belt is yours' : 'New champion') : draw ? 'The belt stays' : 'The champion holds'}</h1>
          {won && !mine && <p className="result-p">{name} took the belt. From the next challenge on, every challenger pays that corner, and if it still holds the belt when the bell rings it takes the purse.</p>}
          {won && mine && <p className="result-p">Your sentence now holds the belt. From the next challenge on, every challenger pays <b>your</b> corner, even the one who takes it off you, and if you still hold it when the bell rings you take the purse.</p>}
          {!won && !draw && (
            <div className="result-money">
              <span className="result-coin"><Icon name="coin" size={22} /></span>
              <span><b className="num">+{near(fight.split.champion)} NEAR</b> went to {champ}'s writer. That's the toll economy: the champion is paid for being the target.</span>
            </div>
          )}
          {draw && <p className="result-p">A draw keeps the champion. {mine ? 'Your' : 'The challenger\'s'} toll still paid the champion's corner.</p>}
          <div className="result-actions">
            {mine && !won && <button className="btn btn-red btn-lg" onClick={onRematch}>Rematch · same sentence</button>}
            {mine && !won && <button className="btn btn-ghost" onClick={onRewrite}>Rewrite it</button>}
            {mine && won && <Link href="/play" className="btn btn-gold btn-lg">See your belt</Link>}
            {!mine && <Link href={`/play/belt/${fight.beltId}`} className="btn btn-red btn-lg">Take your shot at this belt</Link>}
            {mine && won && <button className="btn btn-ghost" onClick={() => setPayoutOpen(true)}><Icon name="coin" size={16} /> Where should the purse go?</button>}
            <button className="btn btn-ghost" onClick={share}><Icon name="copy" size={16} /> {copied ? 'Link copied' : 'Share this bout'}</button>
            {mine && <Link href="/play/me" className="btn btn-ghost"><Icon name="user" size={16} /> See your corner</Link>}
          </div>
        </div>
      </div>
      <section className="receipts panel" aria-label="Receipts">
        <div className="receipts-head"><Icon name="shield" size={16} /> <b>Receipts</b><span>everything above happened on chain; check it yourself</span></div>
        <dl>
          <div><dt>Bout</dt><dd className="num">#{fight.id}</dd></div>
          <div><dt>Referee hash</dt><dd className="num">{shortHex(fight.stateHash, 6)} {verified === true && <span className="ok"><Icon name="check" size={12} /> replayed here, matches</span>}{verified === false && <span className="bad">replay mismatch</span>}</dd></div>
          <div><dt>Fight seed</dt><dd className="num">{shortHex(fight.seed, 6)}</dd></div>
          <div><dt>Arena rule</dt><dd>{fight.rule.name}</dd></div>
          <div><dt>Toll split</dt><dd className="num">{near(fight.split.champion)} champ · {near(fight.split.promoter)} promoter · {near(fight.split.sidePot)} pot · {near(fight.split.protocol)} house · {near(fight.split.forgeFee)} forge</dd></div>
        </dl>
        <div className="receipts-links">
          {fight.receipts.filter((r) => r.url !== '#').map((r) => <a key={r.tx + r.label} href={r.url} target="_blank" rel="noreferrer" className="chip">{r.label} <Icon name="external" size={11} /></a>)}
        </div>
      </section>
      {payoutOpen && <PayoutAddressDialog onClose={() => setPayoutOpen(false)} />}
    </div>
  )
}
