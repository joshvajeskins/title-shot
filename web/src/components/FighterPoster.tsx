import { useState, type CSSProperties } from 'react'
import type { Fighter, School, Spec } from '../game/types'
import './poster.css'

export const SCHOOL_LABEL: Record<School, string> = { BLAZE: 'Blaze', TIDE: 'Tide', VOLT: 'Volt', IRON: 'Iron', MIND: 'Mind', WILD: 'Wild' }
export const SCHOOL_HINT: Record<School, string> = {
  BLAZE: 'burns and big hits', TIDE: 'heals and soaks', VOLT: 'speed and stuns', IRON: 'shields and grit', MIND: 'hexes and control', WILD: 'chaos and bleed',
}

interface Props {
  fighter?: Fighter | null
  spec?: Spec
  sentence?: string
  portrait?: string | null
  corner?: 'champ' | 'chall' | null
  size?: 'sm' | 'md' | 'lg'
  tilt?: number
  className?: string
  style?: CSSProperties
  showSentence?: boolean
  pending?: boolean
}

export function FighterPoster({ fighter, spec: specIn, sentence: sentenceIn, portrait: portraitIn, corner = null, size = 'md', tilt = 0, className = '', style, showSentence = true, pending = false }: Props) {
  const spec = specIn ?? fighter?.spec
  const sentence = sentenceIn ?? fighter?.sentence ?? ''
  const portrait = portraitIn !== undefined ? portraitIn : fighter?.portrait ?? null
  const school = spec?.school ?? 'WILD'
  const [broken, setBroken] = useState<string | null>(null)
  return (
    <figure className={`poster poster-${size} ${corner ? `poster-${corner}` : ''} ${pending ? 'is-pending' : ''} ${className}`} style={{ ...style, ['--tilt' as string]: `${tilt}deg` }}>
      <div className="poster-sheet paper">
        {corner && (
          <div className="poster-corner">
            <span className="display">{corner === 'champ' ? 'Champion' : 'Challenger'}</span>
          </div>
        )}
        <div className="poster-art">
          {portrait && broken !== portrait ? (
            <img src={portrait} alt={spec?.look ?? sentence} loading="lazy" draggable={false} onError={() => setBroken(portrait)} />
          ) : (
            <div className={`poster-fallback school-${school.toLowerCase()}`}>
              <img src={`/art/emblem-${school.toLowerCase()}.webp`} alt="" draggable={false} />
              {pending && <div className="poster-ink" aria-hidden="true" />}
            </div>
          )}
          <span className={`poster-school school-${school.toLowerCase()}`}>{SCHOOL_LABEL[school]}</span>
        </div>
        <figcaption className="poster-caption">
          <span className="poster-name display">{spec?.name ?? '· · ·'}</span>
          {spec?.title && <span className="poster-title serif-i">{spec.title}</span>}
          {showSentence && sentence && <span className="poster-sentence serif-i">“{sentence}”</span>}
        </figcaption>
      </div>
    </figure>
  )
}

export function StatBars({ spec, compact = false }: { spec: Spec; compact?: boolean }) {
  const rows: [string, number][] = [['Power', spec.stats.power], ['Guard', spec.stats.guard], ['Speed', spec.stats.speed], ['Grit', spec.stats.grit]]
  return (
    <dl className={`statbars ${compact ? 'is-compact' : ''}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="statbar">
          <dt>{k}</dt>
          <dd>
            <span className="statbar-track"><span className="statbar-fill" style={{ transform: `scaleX(${Math.min(1, v / 45)})` }} /></span>
            <span className="num">{v}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function MoveList({ spec, names }: { spec: Spec; names?: (id: string) => { name: string; desc: string } | null }) {
  return (
    <ol className="movelist">
      {spec.moves.map((m, i) => {
        const lib = names?.(m.id)
        return (
          <li key={i}>
            <span className="movelist-n display">{i + 1}</span>
            <span className="movelist-label">{m.label}</span>
            {lib && <span className="movelist-lib">{lib.name} · {lib.desc}</span>}
          </li>
        )
      })}
    </ol>
  )
}
