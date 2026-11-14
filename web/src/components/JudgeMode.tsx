import { useEffect, useState } from 'react'
import { useGame } from '../game/context'
import { usePath } from '../lib/router'
import { Icon } from './Icon'
import { Link } from './Link'
import './judge.css'

// ?judge turns on a checklist that walks a judge through the whole loop in about three minutes, with no wallet.
// ?judge=0 turns it off. Progress is kept in this browser only (best effort: storage may be blocked).
const ON = 'ts-judge'
const DONE = 'ts-judge-done'
const REPO = 'https://github.com/joshvajeskins/title-shot'

interface Step { id: string; doThis: string; see: string; href?: string; external?: boolean; auto?: (path: string, hasAccount: boolean) => boolean }
const STEPS: Step[] = [
  { id: 'guest', doThis: 'Enter as a guest', see: 'A testnet account with fight money, made for you. No wallet, no popup.', href: '/enter', auto: (_p, acct) => acct },
  { id: 'belt', doThis: 'Open a belt', see: 'The reigning champion sentence, its toll and your odds.', href: '/play', auto: (p) => p.startsWith('/play/belt/') },
  { id: 'preview', doThis: 'Write a sentence and preview it', see: 'Your fighter, the NEAR AI signature and the signer address the contract will check.' },
  { id: 'bout', doThis: 'Pay the toll and fight', see: 'The bout replayed from the contract, and "state hash matches chain".', auto: (p) => p.startsWith('/play/bout/') },
  { id: 'book', doThis: 'Open the book', see: 'Your challenge with its NEAR transactions and the toll split.', href: '/play/book', auto: (p) => p.startsWith('/play/book') },
  { id: 'proof', doThis: 'Read the tale of the tape', see: 'Deployed code hash, AI signer allowlist, solvency, purses on Base, all read live.', href: '/play/proof', auto: (p) => p.startsWith('/play/proof') },
  { id: 'cheats', doThis: 'See cheats refused', see: 'Tampered fighters, swapped sentences and unknown signers, refused on testnet.', href: `${REPO}/blob/main/docs/CHEAT-RESULTS.md`, external: true },
]

const read = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* storage blocked: the list still works for this visit */ } }

export function JudgeMode() {
  const path = usePath()
  const { account } = useGame()
  const [on, setOn] = useState(false)
  const [open, setOpen] = useState(true)
  const [done, setDone] = useState<string[]>(() => { try { return JSON.parse(read(DONE) ?? '[]') as string[] } catch { return [] } })

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('judge')
    if (q === '0') write(ON, null)
    else if (q !== null) write(ON, '1')
    setOn(read(ON) === '1')
  }, [path])

  useEffect(() => {
    if (!on) return
    const hit = STEPS.filter((s) => s.auto?.(path, !!account) && !done.includes(s.id)).map((s) => s.id)
    if (hit.length) setDone((d) => { const n = [...d, ...hit]; write(DONE, JSON.stringify(n)); return n })
  }, [on, path, account, done])

  if (!on) return null
  const toggle = (id: string) => setDone((d) => { const n = d.includes(id) ? d.filter((x) => x !== id) : [...d, id]; write(DONE, JSON.stringify(n)); return n })
  const exit = () => { write(ON, null); setOn(false) }
  const count = STEPS.filter((s) => done.includes(s.id)).length

  return (
    <aside className={`judge ${open ? 'is-open' : ''}`} aria-label="Judge checklist">
      <button type="button" className="judge-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="eyebrow">For judges · 3 minutes</span>
        <b className="display">{count} / {STEPS.length}</b>
        <Icon name={open ? 'x' : 'shield'} size={16} />
      </button>
      {open ? (
        <>
          <ol className="judge-list">
            {STEPS.map((s) => {
              const ok = done.includes(s.id)
              return (
                <li key={s.id} className={ok ? 'is-done' : ''}>
                  <button type="button" className="judge-check" onClick={() => toggle(s.id)} aria-pressed={ok} aria-label={ok ? `Untick ${s.doThis}` : `Tick ${s.doThis}`}>
                    {ok ? <Icon name="check" size={14} /> : null}
                  </button>
                  <div>
                    {s.href ? (s.external ? <a href={s.href} target="_blank" rel="noreferrer">{s.doThis}</a> : <Link href={s.href}>{s.doThis}</Link>) : <span>{s.doThis}</span>}
                    <p>{s.see}</p>
                  </div>
                </li>
              )
            })}
          </ol>
          <button type="button" className="judge-exit" onClick={exit}>Hide the checklist</button>
        </>
      ) : null}
    </aside>
  )
}
