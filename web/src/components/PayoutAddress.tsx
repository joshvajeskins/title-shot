import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { sound } from '../audio/sound'
import { basenames, inputKey, parsePayoutInput, resolvePayout, saveTarget, type Lookup } from '../game/chain/basenames'
import type { GameClient } from '../game/client'
import { useGame } from '../game/context'
import { BaseName, NameLabel } from './BaseName'
import { Icon } from './Icon'
import './payout.css'

type PayoutClient = GameClient & { payoutAddress?: () => Promise<string | null>; setPayoutAddress?: (a: string) => Promise<void> }

/** Where the season purse is paid: an EVM address on Base Sepolia (typed, or looked up from a Basename), stored with set_evm_address. */
export function PayoutAddressDialog({ onClose }: { onClose: () => void }) {
  const { client } = useGame()
  const c = client as PayoutClient
  const [current, setCurrent] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const supported = typeof c.setPayoutAddress === 'function'
  const input = useMemo(() => parsePayoutInput(value), [value])
  const key = inputKey(input)
  useEffect(() => { void c.payoutAddress?.().then((a) => { setCurrent(a); if (a) setValue(a) }).catch(() => undefined) }, [c])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  useEffect(() => {
    if (!key) { setLookup({ state: 'idle' }); return }
    let live = true
    setLookup({ state: 'resolving', key })
    const t = setTimeout(() => { void resolvePayout(parsePayoutInput(key), basenames).then((l) => { if (live) setLookup(l) }) }, 320)
    return () => { live = false; clearTimeout(t) }
  }, [key])
  const target = saveTarget(input, lookup, current)
  const shown = lookup.state === 'resolved' && lookup.key === key ? lookup : null
  const save = async () => {
    if (!target || !c.setPayoutAddress) return
    setState('saving'); setMsg(null)
    try { await c.setPayoutAddress(target); setCurrent(target); setState('saved'); sound.play('ui_confirm') }
    catch (e) { setState('error'); setMsg(e instanceof Error ? e.message : 'Could not save the address.'); sound.play('ui_error') }
  }
  return createPortal(
    <div className="pa-backdrop" onClick={onClose}>
      <div className="pa panel" role="dialog" aria-modal="true" aria-label="Purse payout address" onClick={(e) => e.stopPropagation()}>
        <button className="pa-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        <span className="eyebrow">Season purse</span>
        <h2 className="display">Where your purse goes</h2>
        <p>Hold a belt at the bell, or defend it, and the contract pays your share of the purse on Base Sepolia, signed through Chain Signatures. Paste any EVM address you control, or your Basename.</p>
        {!supported ? (
          <p className="pa-note">The offline demo has no chain, so there is nothing to save here.</p>
        ) : (
          <>
            <label className="pa-field">
              <span className="sr-only">Base Sepolia address or Basename</span>
              <input value={value} onChange={(e) => { setValue(e.target.value); setState('idle'); setMsg(null) }} placeholder="0x… or yourname.basetest.eth" spellCheck={false} autoComplete="off" autoCapitalize="none" inputMode="text" />
            </label>
            <div className="pa-resolve" aria-live="polite">
              {input.kind === 'invalid' && <p className="pa-err">{input.reason}</p>}
              {lookup.state === 'resolving' && input.kind === 'name' && <p className="pa-looking"><span className="pa-dot" /> Looking up {input.name} on Base Sepolia…</p>}
              {lookup.state === 'failed' && lookup.key === key && <p className="pa-err">{lookup.reason}</p>}
              {(shown || input.kind === 'address') && (
                <div className="pa-target">
                  <span className="eyebrow">Pays to</span>
                  {shown?.name ? <b className="pa-target-name"><NameLabel name={shown.name} /></b> : input.kind === 'address' && lookup.state === 'resolving' ? <span className="pa-target-none">checking for a Basename…</span> : <span className="pa-target-none">no Basename</span>}
                  <code className="pa-target-addr">{shown?.address ?? (input.kind === 'address' ? input.address : '')}</code>
                </div>
              )}
            </div>
            {msg && <p className="pa-err">{msg}</p>}
            <div className="pa-actions">
              <button className="btn btn-gold" disabled={!target || state === 'saving'} onClick={save}>
                {state === 'saving' ? 'Saving on chain…' : state === 'saved' && !target ? <><Icon name="check" size={16} /> Saved</> : 'Save address'}
              </button>
              {current && <span className="pa-current">On file: <BaseName address={current} /></span>}
            </div>
            <p className="pa-note">The contract stores the address, not the name: renaming later does not move your payout. Saving signs one transaction with your account key (not the session key). Testnet only: Base Sepolia ETH has no value.</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
