import type { ReactNode } from 'react'
import { Icon } from './Icon'

export type Verdict = 'pass' | 'warn' | 'fail' | 'info'

const LABEL: Record<Verdict, string> = { pass: 'Checked', warn: 'Note', fail: 'Failing', info: 'Read' }

/** One line of the tale of the tape: what we claim, what the chain says right now, and whether it holds. */
export function TapeRow({ label, verdict, children, note }: { label: string; verdict: Verdict; children: ReactNode; note?: ReactNode }) {
  return (
    <li className={`tape-row v-${verdict}`}>
      <span className="tape-label">{label}</span>
      <div className="tape-value"><div className="tape-main">{children}</div>{note ? <p className="tape-note">{note}</p> : null}</div>
      <span className="tape-verdict" aria-label={LABEL[verdict]}>{LABEL[verdict]}</span>
    </li>
  )
}

/** A hash or address shown in full, selectable, with a copy button that falls back to selecting the text. */
export function Hash({ value, href }: { value: string; href?: string }) {
  const copy = (e: React.MouseEvent<HTMLButtonElement>) => {
    const code = e.currentTarget.previousElementSibling as HTMLElement | null
    navigator.clipboard?.writeText(value).catch(() => {
      if (!code) return
      const r = document.createRange(); r.selectNodeContents(code)
      const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r)
    })
  }
  return (
    <span className="hash">
      {href ? <a href={href} target="_blank" rel="noreferrer" className="mono">{value}</a> : <code className="mono">{value}</code>}
      <button type="button" className="hash-copy" onClick={copy} aria-label="Copy"><Icon name="copy" size={13} /></button>
    </span>
  )
}

export function Counter({ n, label }: { n: string | number; label: string }) {
  return <div className="tape-counter panel"><b className="display num">{n}</b><span>{label}</span></div>
}
