import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import type { Belt } from '../game/types'
import { countdown, eth, near, shortHex } from '../lib/format'
import { FighterPoster } from './FighterPoster'
import { Icon } from './Icon'
import { Link } from './Link'
import './belt.css'

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

export function BeltCard({ belt, index = 0 }: { belt: Belt; index?: number }) {
  const now = useNow()
  const left = belt.season.endsAt - now
  const closing = left > 0 && left < 3600e3
  const reignH = Math.max(0, (now - belt.reignSince) / 3600e3)
  return (
    <article className={`beltcard accent-${belt.accent}`} style={{ ['--i' as string]: index }}>
      <div className="beltcard-belt">
        <img src={belt.art} alt={belt.name} draggable={false} />
      </div>
      <header className="beltcard-head">
        <h2 className="display beltcard-name">{belt.name}</h2>
        <span className="eyebrow">Season {belt.season.id}</span>
      </header>
      <div className="beltcard-champ">
        <FighterPoster fighter={belt.champion} size="sm" tilt={-2.5} showSentence={false} />
        <div className="beltcard-champ-text">
          <span className="eyebrow">Reigning champion</span>
          <strong className="display beltcard-champ-name">{belt.champion.spec.name}</strong>
          <q className="serif-i beltcard-sentence">{belt.champion.sentence}</q>
          <div className="beltcard-record">
            <span><b className="num">{belt.defences}</b> defences</span>
            <span><b className="num">{reignH < 1 ? `${Math.round(reignH * 60)}m` : `${reignH.toFixed(1)}h`}</b> reign</span>
          </div>
        </div>
      </div>
      <dl className="beltcard-facts">
        <div><dt>Purse</dt><dd className="num">{eth(belt.season.purse.amountWei)} ETH <small>· Base</small></dd></div>
        <div><dt>Writer has earned</dt><dd className="num">{near(belt.writerEarnedYocto, 2)} NEAR</dd></div>
        <div><dt>Failed challengers</dt><dd className="num">{belt.failedChallengers}</dd></div>
        <div><dt>Arena rule</dt><dd>{belt.season.rule ? belt.season.rule.name : <span className="sealed"><Icon name="lock" size={13} /> Sealed</span>}</dd></div>
      </dl>
      <footer className="beltcard-foot">
        <div className={`beltcard-bell ${closing ? 'is-closing' : ''}`}>
          <Icon name="bell" size={16} />
          <span>{left > 0 ? <>Bell in <b className="num">{countdown(left)}</b></> : 'Bell rang · settling'}</span>
        </div>
        <Link href={`/play/belt/${belt.id}`} className="btn btn-red" onClick={() => sound.play('ui_confirm')}>
          Take your shot <Icon name="arrow" />
        </Link>
      </footer>
      <a className="beltcard-purse-link" href={belt.season.purse.explorer} target="_blank" rel="noreferrer">
        Purse wallet {shortHex(belt.season.purse.address)} · no one holds this key <Icon name="external" size={12} />
      </a>
    </article>
  )
}
