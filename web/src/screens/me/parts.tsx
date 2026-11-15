import type { ReactNode } from 'react'

export function SecHead({ n, id, title, aside }: { n: string; id: string; title: string; aside?: string }) {
  return (
    <div className="mc-sec-h">
      <span className="mc-sec-n">{n}</span>
      <h2 id={id} className="display">{title}</h2>
      {aside && <small>{aside}</small>}
    </div>
  )
}

export function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="mc-empty">
      <span className="serif-i">{title}</span>
      {body && <p>{body}</p>}
      {children}
    </div>
  )
}

/** Loading: the same blocks the page will fill, so nothing jumps when the chain answers. */
export function CornerSkeleton() {
  return (
    <div className="mc-skel" aria-busy="true" aria-label="Reading your corner from the chain">
      <div className="mc-head">
        <div className="skeleton mc-sk" style={{ height: 250, marginTop: 14 }} />
        <div className="skeleton mc-sk" style={{ height: 250 }} />
      </div>
      {[180, 260, 220].map((h, i) => (
        <div key={i} className="mc-sec" style={{ marginTop: 34 }}>
          <div className="skeleton mc-sk" style={{ height: 36, width: 260 }} />
          <div className="skeleton mc-sk" style={{ height: h }} />
        </div>
      ))}
    </div>
  )
}
