import { useEffect } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import type { Fight } from '../game/types'
import './intro.css'

export function Intro({ fight, beltArt, beltName, onDone }: { fight: Fight; beltArt: string; beltName: string; onDone: () => void }) {
  useEffect(() => {
    sound.play('crowd_roar_1', { volume: 0.5 })
    const t1 = setTimeout(() => sound.play('corner_champ'), 500)
    const t2 = setTimeout(() => sound.play('corner_challenger'), 2700)
    const t3 = setTimeout(onDone, 5200)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onDone])
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
