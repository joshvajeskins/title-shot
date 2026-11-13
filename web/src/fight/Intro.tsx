import { useEffect } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import type { Fight } from '../game/types'
import './intro.css'

export function Intro({ fight, beltArt, beltName, onDone }: { fight: Fight; beltArt: string; beltName: string; onDone: () => void }) {
  useEffect(() => {
    sound.play('crowd_roar_1', { volume: 0.5 })
    const t1 = setTimeout(() => sound.play('corner_champ'), 500)
    const c1 = setTimeout(() => sound.cry(fight.champion.sentenceHash), 1900)
    const t2 = setTimeout(() => sound.play('corner_challenger'), 3200)
    const c2 = setTimeout(() => sound.cry(fight.challenger.sentenceHash), 4500)
    const t3 = setTimeout(onDone, 6600)
    return () => { [t1, c1, t2, c2, t3].forEach(clearTimeout) }
  }, [onDone, fight])
  return (
    <div className="intro" onClick={onDone} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onDone()} aria-label="Skip intro">
      <div className="intro-bg" aria-hidden="true" />
      <div className="intro-belt"><img src={beltArt} alt="" /><span className="display">{beltName}</span></div>
      <div className="intro-row">
        <div className="intro-side intro-left">
          <FighterPoster fighter={fight.champion} corner="champ" size="lg" tilt={-3} />
        </div>
        <div className="intro-vs display print">VS</div>
        <div className="intro-side intro-right">
          <FighterPoster fighter={fight.challenger} corner="chall" size="lg" tilt={3} />
        </div>
      </div>
      <div className="intro-rule"><span className="eyebrow">Arena rule</span> <b>{fight.rule.name}</b> · {fight.rule.desc}</div>
      <span className="intro-skip eyebrow">Tap to skip</span>
    </div>
  )
}
