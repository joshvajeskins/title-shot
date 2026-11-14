import { useEffect, useState } from 'react'
import { BASENAMES, basenames, VANCE_BASE_ADDRESS } from '../game/chain/basenames'
import { baseAddrUrl } from '../game/chain/config'
import { shortHex } from '../lib/format'
import { Icon } from './Icon'
import './payout.css'

const TLD = `.${BASENAMES.parent}`

/** The primary Basename of a Base Sepolia address, or null (none, not verified both ways, still loading, or offline). */
export function useBaseName(address?: string | null): string | null {
  const [found, setFound] = useState<{ address: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!address) return
    let live = true
    void basenames.reverse(address).then((name) => { if (live) setFound({ address, name }) }).catch(() => undefined)
    return () => { live = false }
  }, [address])
  return found && address && found.address === address ? found.name : null
}

/** A name, with the shared `.basetest.eth` suffix set back so the chosen part reads first. */
export function NameLabel({ name }: { name: string }) {
  const head = name.endsWith(TLD) ? name.slice(0, -TLD.length) : name
  return <span className="bn-name">{head}<span className="bn-tld">{name.endsWith(TLD) ? TLD : ''}</span></span>
}

/** A Base address shown as its Basename when it has one (verified forward and back), else as short hex. */
export function BaseName({ address, chars = 4, link = false }: { address?: string | null; chars?: number; link?: boolean }) {
  const name = useBaseName(address)
  if (!address) return null
  const label = name ? <NameLabel name={name} /> : <span className="mono">{shortHex(address, chars)}</span>
  if (!link) return <span className="bn" title={address}>{label}</span>
  return <a className="bn" href={baseAddrUrl(address)} target="_blank" rel="noreferrer" title={address}>{label} <Icon name="external" size={11} /></a>
}

/** Promoter screen: Vance's Base wallet by name, and who holds its key. */
export function VanceBaseWallet() {
  return (
    <div className="bn-wallet">
      <span className="eyebrow">Base wallet</span>
      <BaseName address={VANCE_BASE_ADDRESS} chars={6} link />
      <span className="bn-note"><Icon name="lock" size={11} /> key held by NEAR Chain Signatures · vance.titleshot.testnet</span>
    </div>
  )
}
