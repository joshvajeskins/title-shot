import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { sound } from '../audio/sound'
import { useGame } from '../game/context'
import { near, shortAccount } from '../lib/format'
import { browserStore, exportKey } from '../game/nearKeys'
import { useCompilerMode } from '../game/compiler'
import { PayoutAddressDialog } from './PayoutAddress'
import { navigate, usePath } from '../lib/router'
import { txUrl } from '../game/chain/config'
import { Icon } from './Icon'
import { Link, Wordmark } from './Link'
import './shell.css'

const MoveDialog = lazy(() => import('./wallet/MoveDialog').then((m) => ({ default: m.MoveDialog })))

const NAV: { group: string; items: { href: string; label: string; icon: string; match: (p: string) => boolean }[] }[] = [
  { group: 'Fight night', items: [
    { href: '/play', label: 'The belts', icon: 'ring', match: (p) => p === '/play' || p.startsWith('/play/belt') || p.startsWith('/play/bout') },
    { href: '/play/book', label: 'The book', icon: 'book', match: (p) => p.startsWith('/play/book') },
  ] },
  { group: 'The house', items: [
    { href: '/play/promoter', label: 'The promoter', icon: 'mic', match: (p) => p.startsWith('/play/promoter') },
    { href: '/play/how', label: 'How it works', icon: 'info', match: (p) => p.startsWith('/play/how') },
    { href: '/play/proof', label: 'Tale of the tape', icon: 'shield', match: (p) => p.startsWith('/play/proof') },
  ] },
]

export function Shell({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  const path = usePath()
  const { account, client } = useGame()
  const [muted, setMuted] = useState(sound.isMuted())
  const [menu, setMenu] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const compiler = useCompilerMode(client.mode)
  useEffect(() => { setMenu(false); setMobileMenu(false) }, [path])
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
        {!bare && (compiler === 'standin' || compiler === 'mock') && (
          <div className="mode-banner" role="note">
            <Icon name="info" size={14} />
            {compiler === 'mock'
              ? <span><b>Offline demo.</b> This build simulates the chain in your browser; no transactions are sent.</span>
              : <span><b>Staging contract.</b> The NEAR AI compiler key is pending, so fighters are compiled by a labeled stand-in signer. Tolls, fights, the belt and payouts are real testnet transactions.</span>}
          </div>
        )}
        {!account && !bare && (
          <div className="guest-nudge">
            <span><b>You're spectating.</b><span className="hide-sm"> Get a free testnet fighter account to take a shot.</span></span>
            <Link href={`/enter?next=${encodeURIComponent(path)}`} className="btn btn-red btn-sm">Get in the ring</Link>
          </div>
        )}
        {account && !bare && (
          <div className="mobile-identity">
            <IdentityBlock open={mobileMenu} setOpen={setMobileMenu} down onSignOut={async () => { await client.signOut(); navigate('/') }} />
          </div>
        )}
        {children}
      </main>
      <nav className="tabbar" aria-label="Main navigation">
        {NAV.flatMap((g) => g.items).map((it) => (
          <Link key={it.href} href={it.href} className={`tab ${it.match(path) ? 'is-active' : ''}`}>
            <Icon name={it.icon} size={20} />
            <span>{it.label.replace('Tale of the tape', 'Proof').replace('The ', '').replace('How it works', 'How')}</span>
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

function IdentityBlock({ open, setOpen, onSignOut, down = false }: { open: boolean; setOpen: (o: boolean) => void; onSignOut: () => void; down?: boolean }) {
  const { account, client, refreshAccount } = useGame()
  const [note, setNote] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [working, setWorking] = useState(false)
  useEffect(() => { if (!open) { setNote(null); setLink(null) } }, [open])
  if (!account) {
    return (
      <Link href="/enter" className="identity identity-empty">
        <span className="identity-avatar"><Icon name="user" /></span>
        <span className="identity-text"><strong>Spectator</strong><small>Get a fighter account</small></span>
      </Link>
    )
  }
  const initials = account.id.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase()
  const wallet = account.kind === 'wallet'
  const live = client.mode === 'testnet'
  const withdraw = async () => {
    if (!client.withdraw || working) return
    setWorking(true); setLink(null); setNote('Approve the withdrawal in your wallet.')
    try {
      const tx = await client.withdraw()
      setNote(`Withdrawn to ${account.id}.`); setLink(txUrl(tx)); sound.play('kaching')
      await refreshAccount()
    } catch (e) { setNote(e instanceof Error ? e.message : 'The withdrawal did not go through.'); sound.play('ui_error') }
    finally { setWorking(false) }
  }
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
        <div className={`identity-menu panel ${down ? 'is-down' : ''}`} role="menu">
          {wallet && <p className="identity-wallet"><span className="identity-wallet-dot" aria-hidden="true" /> NEAR wallet connected<b title={account.id}>{account.id}</b></p>}
          <Link href="/play/book" className="identity-menu-item" role="menuitem"><Icon name="book" size={16} /> My bouts</Link>
          <Link href="/play/how" className="identity-menu-item" role="menuitem"><Icon name="info" size={16} /> How the money moves</Link>
          <button className="identity-menu-item" role="menuitem" onClick={() => setPayoutOpen(true)}><Icon name="coin" size={16} /> Purse payout address</button>
          {live && wallet && BigInt(account.balanceYocto) > 0n && <button className="identity-menu-item" role="menuitem" onClick={withdraw} disabled={working}><Icon name="coin" size={16} /> Withdraw {near(account.balanceYocto, 3)} NEAR</button>}
          {live && !wallet && <button className="identity-menu-item" role="menuitem" onClick={() => { setMoveOpen(true); setOpen(false) }}><Icon name="arrow" size={16} /> Move to my wallet</button>}
          {live && !wallet && <button className="identity-menu-item" role="menuitem" onClick={backup}><Icon name="lock" size={16} /> Back up my key</button>}
          {note && <p className="identity-note">{note}{link && <> <a href={link} target="_blank" rel="noreferrer" className="identity-note-link">View tx <Icon name="external" size={10} /></a></>}</p>}
          <Link href="/" className="identity-menu-item" role="menuitem"><Icon name="ring" size={16} /> Website</Link>
          <button className="identity-menu-item" role="menuitem" onClick={onSignOut}><Icon name="x" size={16} /> {wallet ? 'Disconnect wallet' : 'Sign out'}</button>
        </div>
      )}
      {payoutOpen && <PayoutAddressDialog onClose={() => setPayoutOpen(false)} />}
      {moveOpen && <Suspense fallback={null}><MoveDialog onClose={() => setMoveOpen(false)} /></Suspense>}
    </div>
  )
}
