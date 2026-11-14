import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import { baseBookings } from '../game/baseBookings'
import { useGame } from '../game/context'
import type { Fight } from '../game/types'
import './intro.css'

export function Intro({ fight, beltArt, beltName, onDone }: { fight: Fight; beltArt: string; beltName: string; onDone: () => void }) {
  const { client } = useGame()
  // A title shot bought on Base over x402: the announcer calls it, and the poster carries who paid.
  const [fromBase, setFromBase] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const timers: ReturnType<typeof setTimeout>[] = []
    void sound.music(null, 500)
    sound.play('crowd_roar_1', { volume: 0.18 })
    timers.push(setTimeout(() => sound.play('corner_champ'), 800), setTimeout(() => sound.cry(fight.champion.sentenceHash), 1900))
    const lookup = baseBookings(client.mode).then((m) => m.get(fight.challenger.writer) ?? null)
    const cap = new Promise<null>((r) => timers.push(setTimeout(() => r(null), 1500)))
    void Promise.race([lookup, cap]).then((payer) => {
      if (!live) return
      setFromBase(payer)
      // the Base call runs ~4.8 s against ~3 s for the usual one, so the cry and the hand-off move later
      timers.push(
        setTimeout(() => sound.play(payer ? 'base_challenger' : 'corner_challenger'), 3200),
        setTimeout(() => sound.cry(fight.challenger.sentenceHash), payer ? 7400 : 4500),
        setTimeout(onDone, payer ? 9300 : 6600),
      )
    })
    return () => { live = false; timers.forEach(clearTimeout) }
  }, [onDone, fight, client.mode])
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
          {fromBase ? <span className="intro-base">Booked on Base · x402 · {fromBase}</span> : null}
        </div>
      </div>
      <div className="intro-rule"><span className="eyebrow">Arena rule</span> <b>{fight.rule.name}</b> · {fight.rule.desc}</div>
      <span className="intro-skip eyebrow">Tap to skip</span>
    </div>
  )
}
