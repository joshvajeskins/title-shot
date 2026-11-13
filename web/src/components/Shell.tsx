import { useEffect, useState, type ReactNode } from 'react'
import { sound } from '../audio/sound'
import { useGame } from '../game/context'
import { near, shortAccount } from '../lib/format'
import { browserStore, exportKey } from '../game/nearKeys'
import { navigate, usePath } from '../lib/router'
import { Icon } from './Icon'
import { Link, Wordmark } from './Link'
import './shell.css'

const NAV: { group: string; items: { href: string; label: string; icon: string; match: (p: string) => boolean }[] }[] = [
  { group: 'Fight night', items: [
    { href: '/play', label: 'The belts', icon: 'ring', match: (p) => p === '/play' || p.startsWith('/play/belt') || p.startsWith('/play/bout') },
    { href: '/play/book', label: 'The book', icon: 'book', match: (p) => p.startsWith('/play/book') },
  ] },
  { group: 'The house', items: [
    { href: '/play/promoter', label: 'The promoter', icon: 'mic', match: (p) => p.startsWith('/play/promoter') },
    { href: '/play/how', label: 'How it works', icon: 'info', match: (p) => p.startsWith('/play/how') },
  ] },
]

export function Shell({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  const path = usePath()
  const { account, client } = useGame()
  const [muted, setMuted] = useState(sound.isMuted())
  const [menu, setMenu] = useState(false)
  useEffect(() => { setMenu(false) }, [path])
  const toggleSound = () => { const m = !muted; setMuted(m); sound.setMuted(m); if (!m) sound.play('ui_tick') }
  return (
    <div className={`shell ${bare ? 'is-bare' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <Link href="/" className="sidebar-logo"><Wordmark size={30} /></Link>
        <nav className="sidebar-nav">
          {NAV.map((g) => (
            <div key={g.group} className="sidebar-group">
              <div className="eyebrow sidebar-group-title">{g.group}</div>
              {g.items.map((it) => (
                <Link key={it.href} href={it.href} className={`sidebar-item ${it.match(path) ? 'is-active' : ''}`} onClick={() => sound.play('ui_tick')}>
                  <Icon name={it.icon} /> <span>{it.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="sidebar-item sound-toggle" onClick={toggleSound} aria-pressed={!muted}>
            <Icon name={muted ? 'mute' : 'sound'} /> <span>{muted ? 'Sound off' : 'Sound on'}</span>
          </button>
          <IdentityBlock open={menu} setOpen={setMenu} onSignOut={async () => { await client.signOut(); navigate('/') }} />
        </div>
      </aside>
      <main className="shell-main">
        {!account && !bare && (
          <div className="guest-nudge">
            <span><b>You're spectating.</b><span className="hide-sm"> Get a free testnet fighter account to take a shot.</span></span>
            <Link href={`/enter?next=${encodeURIComponent(path)}`} className="btn btn-red btn-sm">Get in the ring</Link>
          </div>
        )}
        {children}
      </main>
      <nav className="tabbar" aria-label="Main navigation">
        {NAV.flatMap((g) => g.items).map((it) => (
          <Link key={it.href} href={it.href} className={`tab ${it.match(path) ? 'is-active' : ''}`}>
            <Icon name={it.icon} size={20} />
            <span>{it.label.replace('The ', '').replace('How it works', 'How')}</span>
          </Link>
        ))}
        <button className="tab" onClick={toggleSound} aria-pressed={!muted}>
          <Icon name={muted ? 'mute' : 'sound'} size={20} />
          <span>{muted ? 'Muted' : 'Sound'}</span>
        </button>
      </nav>
    </div>
  )
}

function IdentityBlock({ open, setOpen, onSignOut }: { open: boolean; setOpen: (o: boolean) => void; onSignOut: () => void }) {
  const { account, client } = useGame()
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { if (!open) setNote(null) }, [open])
  if (!account) {
    return (
      <Link href="/enter" className="identity identity-empty">
        <span className="identity-avatar"><Icon name="user" /></span>
        <span className="identity-text"><strong>Spectator</strong><small>Get a fighter account</small></span>
      </Link>
    )
  }
  const initials = account.id.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase()
  const backup = async () => {
    const k = client.mode === 'testnet' ? exportKey(browserStore()) : null
    if (!k) return
    try { await navigator.clipboard.writeText(`${k.accountId}\n${k.privateKey}`); setNote('Key copied. Store it like a password: it controls this account.') }
    catch { setNote('Your browser blocked the clipboard.') }
  }
  return (
    <div className="identity-wrap">
      <button className="identity" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="identity-avatar display">{initials}</span>
        <span className="identity-text">
          <strong title={account.id}>{shortAccount(account.id)}</strong>
          <small className="num">{near(account.balanceYocto, 3)} NEAR · {account.kind === 'guest' ? 'guest key' : 'wallet'}{client.mode === 'mock' ? ' · demo' : ''}</small>
        </span>
        <Icon name="dots" />
      </button>
      {open && (
        <div className="identity-menu panel" role="menu">
          <Link href="/play/book" className="identity-menu-item" role="menuitem"><Icon name="book" size={16} /> My bouts</Link>
          <Link href="/play/how" className="identity-menu-item" role="menuitem"><Icon name="info" size={16} /> How the money moves</Link>
          {client.mode === 'testnet' && <button className="identity-menu-item" role="menuitem" onClick={backup}><Icon name="lock" size={16} /> Back up my key</button>}
          {note && <p className="identity-note">{note}</p>}
          <Link href="/" className="identity-menu-item" role="menuitem"><Icon name="ring" size={16} /> Website</Link>
          <button className="identity-menu-item" role="menuitem" onClick={onSignOut}><Icon name="x" size={16} /> Sign out</button>
        </div>
      )}
    </div>
  )
}
