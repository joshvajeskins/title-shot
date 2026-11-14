/**
 * The hero title, letter by letter: each letter slams down onto the poster. Delays shrink as the word goes on,
 * so the slam reads as one blow rather than a metronome (~380 ms per letter, ~330 ms spread).
 */
const WORDS = [{ text: 'Title', cls: 'print' }, { text: 'Shot', cls: 'hero-shot' }]
const N = WORDS.reduce((a, w) => a + w.text.length, 0)
const delay = (i: number) => Math.round(330 * (1 - Math.pow(1 - i / N, 1.7)))

export function SlamTitle() {
  let i = 0
  return (
    <h1 className="display hero-title" aria-label="Title Shot">
      {WORDS.map((w, wi) => (
        <span key={w.text} className={`slam-word ${w.cls}`} aria-hidden="true">
          {[...w.text].map((ch) => <span key={i} className="slam" style={{ animationDelay: `${delay(i++)}ms` }}>{ch}</span>)}
          {wi < WORDS.length - 1 ? ' ' : null}
        </span>
      ))}
    </h1>
  )
}
