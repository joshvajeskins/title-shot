import type { CSSProperties } from 'react'
import { FighterPoster } from '../../components/FighterPoster'
import type { Spec } from '../../game/types'

const pigeon: Spec = { name: 'Counselor Coo', title: '', look: '', cry: '', school: 'MIND', style: 'TACTICIAN', moves: [], stats: { power: 14, guard: 18, speed: 25, grit: 13 } }
const granny: Spec = { name: 'Granny Purl', title: '', look: '', cry: '', school: 'IRON', style: 'COUNTERPUNCHER', moves: [], stats: { power: 10, guard: 25, speed: 10, grit: 25 } }

const STEPS = [
  { n: '01', h: 'Write', p: 'Up to 120 characters. Spar for free and see your odds before you pay a thing.', art: <div className="slip"><span className="serif-i">a pigeon with a law degree</span></div> },
  { n: '02', h: 'Forge', p: 'An AI in a sealed enclave prints a fighter: a face, four stats, three moves named after your words.', art: <img src="/art/forge-press.webp" alt="" /> },
  { n: '03', h: 'Fight', p: 'Best of three, refereed by the contract. A draw keeps the champion.', art: <div className="loop-fight"><FighterPoster spec={pigeon} portrait="/art/fighter-pigeon.webp" size="sm" tilt={-4} showSentence={false} /><FighterPoster spec={granny} portrait="/art/fighter-grandma.webp" size="sm" tilt={4} showSentence={false} /></div> },
  { n: '04', h: 'Hold the belt', p: 'Every challenger pays you, even the one who beats you. Hold it at the bell and take the purse.', art: <img src="/art/belt-midnight.webp" alt="" /> },
]

/** How it plays: four ticket-stub bills, dealt onto the table as they scroll in. */
export function Loop() {
  return (
    <section id="loop" className="land-sec">
      <header className="sec-head" data-reveal>
        <span className="sec-kicker">How it plays</span>
        <h2 className="display print sec-title">One sentence. Thirty seconds.</h2>
      </header>
      <ol className="loop">
        {STEPS.map((s, i) => (
          <li key={s.n} className="bill" data-reveal style={{ '--d': `${[0, 70, 120, 160][i]}ms`, '--tilt': `${[-0.6, 0.5, -0.4, 0.7][i]}deg` } as CSSProperties}>
            <div className="bill-in stub">
              <span className="stub-n display">{s.n}</span>
              <div className="stub-art">{s.art}</div>
              <h3 className="display">{s.h}</h3>
              <p>{s.p}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
