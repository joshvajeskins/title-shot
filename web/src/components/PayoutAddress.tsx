import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { sound } from '../audio/sound'
import { basenames, inputKey, parsePayoutInput, resolvePayout, saveTarget, type Lookup } from '../game/chain/basenames'
import type { GameClient } from '../game/client'
import { useGame } from '../game/context'
import { useWalletLink } from '../game/evm/useWalletLink'
import { eth } from '../lib/format'
import { BaseName, NameLabel } from './BaseName'
import { Icon } from './Icon'
import { PayoutWallet } from './PayoutWallet'
import './payout.css'

type PayoutClient = GameClient & { payoutAddress?: () => Promise<string | null>; setPayoutAddress?: (a: string) => Promise<void> }
type Path = 'wallet' | 'paste'
const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Where the season purse is paid: an EVM address on Base Sepolia (from a connected wallet that signs for it, typed, or looked up from a Basename), stored with set_evm_address. */
/** `claim`: the bell already created this payout with no address; saving names its address once (claim_payout). */
export function PayoutAddressDialog({ onClose, claim }: { onClose: () => void; claim?: { payoutId: number; amountWei: string } }) {
  const { client, account } = useGame()
  const c = client as PayoutClient
  const [path, setPath] = useState<Path>('wallet')
  const [current, setCurrent] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const link = useWalletLink(account?.id ?? null)
  const supported = typeof (claim ? c.claimPayout : c.setPayoutAddress) === 'function'
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
  // a new wallet outcome is a new target: forget the last save's result
  const linked = link.state.phase === 'linked' ? link.state.address : null
  useEffect(() => { setState('idle'); setMsg(null) }, [linked])
  // a claim may use the address already on file; a plain save only when it changes
  const onFile = claim ? null : current
  const target = path === 'wallet' ? (linked && !same(linked, onFile) ? linked : null) : saveTarget(input, lookup, onFile)
  const shown = lookup.state === 'resolved' && lookup.key === key ? lookup : null
  const choose = (p: Path) => { setPath(p); setState('idle'); setMsg(null) }
  const save = async () => {
    if (!target || !(claim ? c.claimPayout : c.setPayoutAddress)) return
    setState('saving'); setMsg(null)
    try {
      if (claim) await c.claimPayout!(claim.payoutId, target)
      else { await c.setPayoutAddress!(target); setCurrent(target) }
      setState('saved'); sound.play('ui_confirm')
    }
    catch (e) { setState('error'); setMsg(e instanceof Error ? e.message : 'Could not save the address.'); sound.play('ui_error') }
  }
  return createPortal(
    <div className="pa-backdrop" onClick={onClose}>
      <div className="pa panel" role="dialog" aria-modal="true" aria-label="Purse payout address" onClick={(e) => e.stopPropagation()}>
        <button className="pa-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        <span className="eyebrow">Season purse</span>
        <h2 className="display">{claim ? 'Claim your purse share' : 'Where your purse goes'}</h2>
        <p>{claim ? `The bell set aside ${eth(claim.amountWei)} ETH for you, but your corner had no Base address. Name one: the contract records it once and signs the payout through Chain Signatures at the next tick.` : 'Hold a belt at the bell, or defend it, and the contract pays your share of the purse on Base Sepolia, signed through Chain Signatures. Connect your wallet, or paste any EVM address you control or your Basename.'}</p>
        {!supported ? (
          <p className="pa-note">The offline demo has no chain, so there is nothing to save here.</p>
        ) : (
          <>
            <div className="pa-paths" role="tablist" aria-label="How to give your address">
              <button type="button" role="tab" aria-selected={path === 'wallet'} className={path === 'wallet' ? 'is-on' : ''} onClick={() => choose('wallet')}>Connect a wallet</button>
              <button type="button" role="tab" aria-selected={path === 'paste'} className={path === 'paste' ? 'is-on' : ''} onClick={() => choose('paste')}>Paste address or Basename</button>
            </div>
            {path === 'wallet' ? (
              <div role="tabpanel" aria-label="Connect a wallet"><PayoutWallet link={link} onPaste={() => choose('paste')} onFile={(a) => same(a, onFile)} /></div>
            ) : (
              <div role="tabpanel" aria-label="Paste an address" className="pa-paste">
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
              </div>
            )}
            {msg && <p className="pa-err">{msg}</p>}
            <div className="pa-actions">
              {(path === 'paste' || linked || state !== 'idle') && <button className="btn btn-gold" disabled={!target || state === 'saving' || (claim && state === 'saved')} onClick={save}>
                {state === 'saving' ? 'Saving on chain…' : !claim && path === 'wallet' && linked && !target && state !== 'saved' ? <><Icon name="check" size={16} /> On file</> : state === 'saved' && (claim || !target) ? <><Icon name="check" size={16} /> {claim ? 'Claimed' : 'Saved'}</> : claim ? 'Claim to this address' : 'Save address'}
              </button>}
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
