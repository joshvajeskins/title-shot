import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { sound } from '../audio/sound'
import type { GameClient } from '../game/client'
import { useGame } from '../game/context'
import { Icon } from './Icon'
import './payout.css'

type PayoutClient = GameClient & { payoutAddress?: () => Promise<string | null>; setPayoutAddress?: (a: string) => Promise<void> }
const VALID = /^0x[0-9a-fA-F]{40}$/

/** Where the season purse is paid: an EVM address on Base Sepolia, stored on chain with set_evm_address. */
export function PayoutAddressDialog({ onClose }: { onClose: () => void }) {
  const { client } = useGame()
  const c = client as PayoutClient
  const [current, setCurrent] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const supported = typeof c.setPayoutAddress === 'function'
  useEffect(() => { void c.payoutAddress?.().then((a) => { setCurrent(a); if (a) setValue(a) }).catch(() => undefined) }, [c])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const ok = VALID.test(value.trim())
  const save = async () => {
    if (!ok || !c.setPayoutAddress) return
    setState('saving'); setMsg(null)
    try { await c.setPayoutAddress(value.trim()); setCurrent(value.trim()); setState('saved'); sound.play('ui_confirm') }
    catch (e) { setState('error'); setMsg(e instanceof Error ? e.message : 'Could not save the address.'); sound.play('ui_error') }
  }
  return createPortal(
    <div className="pa-backdrop" onClick={onClose}>
      <div className="pa panel" role="dialog" aria-modal="true" aria-label="Purse payout address" onClick={(e) => e.stopPropagation()}>
        <button className="pa-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        <span className="eyebrow">Season purse</span>
        <h2 className="display">Where your purse goes</h2>
        <p>Hold a belt at the bell, or defend it, and the contract pays your share of the purse on Base Sepolia, signed through Chain Signatures. Paste any EVM address you control.</p>
        {!supported ? (
          <p className="pa-note">The offline demo has no chain, so there is nothing to save here.</p>
        ) : (
          <>
            <label className="pa-field">
              <span className="sr-only">Base Sepolia address</span>
              <input value={value} onChange={(e) => { setValue(e.target.value); setState('idle') }} placeholder="0x…" spellCheck={false} autoComplete="off" inputMode="text" />
            </label>
            {value && !ok && <p className="pa-err">That isn't an EVM address (0x followed by 40 hex characters).</p>}
            {msg && <p className="pa-err">{msg}</p>}
            <div className="pa-actions">
              <button className="btn btn-gold" disabled={!ok || state === 'saving' || value.trim() === current} onClick={save}>
                {state === 'saving' ? 'Saving on chain…' : state === 'saved' ? <><Icon name="check" size={16} /> Saved</> : 'Save address'}
              </button>
              {current && <span className="pa-current mono">On file: {current.slice(0, 6)}…{current.slice(-4)}</span>}
            </div>
            <p className="pa-note">Saving signs one transaction with your account key (not the session key). Testnet only: Base Sepolia ETH has no value.</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
