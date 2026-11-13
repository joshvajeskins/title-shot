import { useEffect } from 'react'
import { sound } from '../audio/sound'
import { BeltCard } from '../components/BeltCard'
import { Icon } from '../components/Icon'
import { Link, Wordmark } from '../components/Link'
import { useAsync, useGame } from '../game/context'
import './lobby.css'

export function Lobby() {
  const { client } = useGame()
  const { data: belts, error, loading, reload } = useAsync(() => client.belts(), [client])
  useEffect(() => { void sound.music('lobby_loop') }, [])
  return (
    <div className="page lobby">
      <div className="lobby-hero" aria-hidden="true" />
      <div className="mobile-top"><Link href="/"><Wordmark size={26} /></Link><span className="chip chip-gold">Testnet</span></div>
      <header className="page-head lobby-head">
        <div>
          <span className="eyebrow">Fight night · live on NEAR testnet</span>
          <h1 className="display print page-title">The belts</h1>
          <p className="page-sub">Every failed challenger pays the champion's writer. Whoever holds a belt when the bell rings takes the purse.</p>
        </div>
        <Link href="/play/promoter" className="lobby-vance">
          <img src="/art/promoter-vance.webp" alt="" />
          <span><b>Velvet Vance</b><small>wrote tonight's openers · funds the purses</small></span>
          <Icon name="arrow" size={16} />
        </Link>
      </header>
      {loading && !belts && (
        <div className="belt-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 560 }} />)}</div>
      )}
      {error && (
        <div className="state-box panel">
          <span className="serif-i">The ring lights flickered.</span>
          <span>We couldn't read the belts from the chain ({error}).</span>
          <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="refresh" size={16} /> Try again</button>
        </div>
      )}
      {belts && belts.length === 0 && (
        <div className="state-box panel">
          <span className="serif-i">No belts on the card tonight.</span>
          <span>The promoter opens the next season shortly. Check back in a minute.</span>
        </div>
      )}
      {belts && belts.length > 0 && (
        <div className="belt-grid">{belts.map((b, i) => <BeltCard key={b.id} belt={b} index={i} />)}</div>
      )}
    </div>
  )
}
