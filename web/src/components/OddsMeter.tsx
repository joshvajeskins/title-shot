import { useEffect, useRef, useState } from 'react'
import { sound } from '../audio/sound'
import type { Odds, Rule } from '../game/types'
import { near } from '../lib/format'
import { Icon } from './Icon'

export function OddsMeter({ odds, champName }: { odds: Odds; champName: string }) {
  const win = Math.round(odds.win * 100)
  const draw = Math.round(odds.draw * 100)
  const loss = Math.max(0, 100 - win - draw)
  const said = useRef('')
  useEffect(() => {
    const key = `${win}-${draw}`
    if (said.current === key) return
    said.current = key
    const t = setTimeout(() => sound.play(win >= 50 ? 'odds_good' : win < 25 ? 'odds_long' : 'close'), 450)
    return () => clearTimeout(t)
  }, [win, draw])
  return (
    <div className="odds">
      <div className="odds-head">
        <span className="odds-big display num">{win}%</span>
        <span className="odds-label">to take the belt from <b>{champName}</b></span>
      </div>
      <div className="odds-bar" role="img" aria-label={`${win}% win, ${draw}% draw, ${loss}% loss`}>
        <span className="odds-win" style={{ flexGrow: win }} />
        <span className="odds-draw" style={{ flexGrow: draw }} />
        <span className="odds-loss" style={{ flexGrow: loss }} />
      </div>
      <div className="odds-legend"><span><i className="odds-win" />win {win}%</span><span><i className="odds-draw" />draw {draw}% (champion keeps)</span><span><i className="odds-loss" />loss {loss}%</span></div>
      <p className="odds-foot">{odds.n} simulated bouts in your browser, using the same Rust referee the contract runs.</p>
    </div>
  )
}

export function TollBreakdown({ tollYocto, champName, rule }: { tollYocto: string; champName: string; rule: Rule | null }) {
  const [open, setOpen] = useState(false)
  const t = BigInt(tollYocto)
  const fee = 10n ** 22n // 0.01 NEAR forge fee
  const rest = t > fee ? t - fee : 0n
  const rows: [string, bigint][] = [
    [`${champName}'s writer (if you lose)`, (rest * 60n) / 100n],
    ['Promoter (funds purses and openers)', (rest * 25n) / 100n],
    ['Season side-pot (paid at the bell)', (rest * 10n) / 100n],
    ['House', rest - (rest * 60n) / 100n - (rest * 25n) / 100n - (rest * 10n) / 100n],
    ['Forge (NEAR AI compile and delivery)', fee],
  ]
  return (
    <div className="toll panel">
      <button className="toll-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="coin" size={16} />
        <span>Where your {near(tollYocto)} NEAR goes</span>
        <span className={`toll-caret ${open ? 'is-open' : ''}`}>+</span>
      </button>
      {open && (
        <div className="toll-body">
          <ul>{rows.map(([k, v]) => <li key={k}><span>{k}</span><b className="num">{near(v, 4)}</b></li>)}</ul>
          <p>Win and the belt is yours: from then on every failed challenger's split pays <i>you</i>. A draw keeps the champion. If the forge times out or the AI refuses your sentence, the toll comes back minus the forge fee.</p>
          <p className="toll-rule"><Icon name="lock" size={13} /> Arena rule: {rule ? <><b>{rule.name}</b> · {rule.desc}</> : <>sealed until the first bout of the season. Nobody, the promoter included, knew it when tonight's opener was written.</>}</p>
        </div>
      )}
    </div>
  )
}
