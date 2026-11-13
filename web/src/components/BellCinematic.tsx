import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { sound } from '../audio/sound'
import type { Bell } from '../game/types'
import { eth, near, shortAccount, shortHex } from '../lib/format'
import { Icon } from './Icon'
import './bell.css'

/** The season bell: purse split into Base Sepolia payouts signed by the contract through Chain Signatures. */
export function BellCinematic({ bell, beltName, onClose }: { bell: Bell; beltName: string; onClose: () => void }) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    void sound.music('bell_cinematic', 200)
    sound.play('bell_triple')
    const t = [
      setTimeout(() => { sound.play('bell_season'); setStep(1) }, 700),
      setTimeout(() => { sound.play('purse'); setStep(2) }, 3200),
      setTimeout(() => { sound.play('coins_pour'); setStep(3) }, 4600),
    ]
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => { t.forEach(clearTimeout); window.removeEventListener('keydown', k); void sound.music('lobby_loop') }
  }, [onClose])
  const total = BigInt(bell.purseWei || '0') || 1n
  return createPortal(
    <div className="bellc" role="dialog" aria-modal="true" aria-label={`${beltName} season ${bell.seasonId} bell`}>
      <button className="bellc-close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
      <div className="bellc-stage">
        <img className={`bellc-bell ${step >= 0 ? 'is-ringing' : ''}`} src="/art/bell.webp" alt="" />
        <h2 className="display print bellc-title">{step >= 1 ? "That's the bell" : ' '}</h2>
        <p className="serif-i bellc-sub">{beltName} · season {bell.seasonId} closed with <b>{bell.holderName}</b> holding the belt.</p>
      </div>
      {step >= 2 && (
        <section className="bellc-purse">
          <div className="bellc-head">
            <span className="eyebrow">Purse · {eth(bell.purseWei)} ETH on Base Sepolia</span>
            <span className="chip chip-gold"><Icon name="lock" size={12} /> signed by the contract, no key holder</span>
          </div>
          <ul className="bellc-rows">
            {bell.payouts.map((p, i) => {
              const pct = Number((BigInt(p.amountWei) * 1000n) / total) / 10
              return (
                <li key={p.payee + i} style={{ ['--d' as string]: `${i * 140}ms` }}>
                  <div className="bellc-who">
                    <b>{p.name}</b>
                    <small>{shortAccount(p.payee)} · {p.share === 'holder' ? 'final holder' : p.share === 'refund' ? 'no challengers: refund' : `${p.defences} defences`}</small>
                  </div>
                  <div className="bellc-bar"><span style={{ transform: step >= 3 ? `scaleX(${pct / 100})` : 'scaleX(0)' }} /></div>
                  <div className="bellc-amt num">{eth(p.amountWei, 5)} ETH <small>{pct}%</small></div>
                  <div className="bellc-tx">
                    {p.status === 'mined' && p.explorer ? <a href={p.explorer} target="_blank" rel="noreferrer" className="chip chip-blue">{shortHex(p.tx ?? '', 4)} <Icon name="external" size={11} /></a>
                      : <span className="chip">{p.status === 'unclaimed' ? 'awaiting address' : p.status === 'signed' ? 'signed · broadcasting' : 'signing'}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="bellc-note">Half the purse goes to whoever holds the belt at the bell, half by successful defences, at most 25% per account. The season side-pot of {near(bell.sidePotYocto, 3)} NEAR went to the final holder's balance.</p>
        </section>
      )}
    </div>,
    document.body,
  )
}
