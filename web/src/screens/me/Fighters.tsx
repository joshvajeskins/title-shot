import { FighterPoster, MoveList, SCHOOL_LABEL, StatBars } from '../../components/FighterPoster'
import { Icon } from '../../components/Icon'
import { Link } from '../../components/Link'
import type { CornerFighter } from '../../game/corner/load'
import { moveInfo } from '../../game/library'
import { plural, shortAccount } from '../../lib/format'
import { Empty, SecHead } from './parts'

export function Fighters({ fighters, self }: { fighters: CornerFighter[]; self: boolean }) {
  return (
    <section className="mc-sec" aria-labelledby="mc-fighters">
      <SecHead n="02" id="mc-fighters" title={self ? 'Your fighters' : 'Fighters'} aside={fighters.length ? plural(fighters.length, 'sentence') + ' on file' : undefined} />
      {fighters.length === 0 ? (
        <Empty title={self ? 'No fighter on file. Write your first.' : 'No fighter on file.'} body="One sentence becomes a fighter: NEAR AI compiles it under the public rulebook, the contract checks the signature, and the fighter is yours to send at any belt.">
          <Link href="/play" className="btn btn-red btn-sm"><Icon name="pen" size={15} /> Write a fighter</Link>
        </Empty>
      ) : (
        <div className="mc-fighters">
          {fighters.map(({ fighter: f, record: r, wroteIt, holds }) => (
            <article key={f.sentenceHash} className="mc-fighter panel">
              <FighterPoster fighter={f} size="sm" tilt={-1.5} showSentence={false} />
              <div className="mc-fighter-body">
                <div>
                  <span className="eyebrow">{SCHOOL_LABEL[f.spec.school]} · {f.spec.style.toLowerCase()}</span>
                  <h3 className="display mc-fighter-name">{f.spec.name}</h3>
                </div>
                {f.spec.title && <p className="mc-fighter-title">{f.spec.title}</p>}
                <div className="mc-record" aria-label={`Record in your bouts: ${r.w} wins, ${r.l} losses, ${r.d} draws, ${r.defences} title defences`}>
                  <span className="mc-rec is-w"><b className="num">{r.w}</b><span>Wins</span></span>
                  <span className="mc-rec is-l"><b className="num">{r.l}</b><span>Losses</span></span>
                  <span className="mc-rec"><b className="num">{r.d}</b><span>Draws</span></span>
                  <span className="mc-rec is-def"><b className="num">{r.defences}</b><span>Defences</span></span>
                </div>
                <q>{f.sentence}</q>
                <div className="mc-byline">
                  {wroteIt ? <span className="chip chip-red"><Icon name="pen" size={11} /> {self ? 'Written by you' : 'Written by this corner'}</span>
                    : <span className="chip" title={f.writer}>First written by {shortAccount(f.writer)}</span>}
                  {holds.map((b) => <span key={b.id} className="chip chip-gold"><Icon name="ring" size={11} /> Holds {b.name.replace('The ', '')}</span>)}
                </div>
                <StatBars spec={f.spec} compact />
                <MoveList spec={f.spec} names={moveInfo} />
              </div>
            </article>
          ))}
        </div>
      )}
      {fighters.length > 0 && <p className="mc-note">Records count only the bouts this corner fought, as challenger or as holder. A draw while holding the belt keeps it, so the contract counts it as a defence.</p>}
    </section>
  )
}
