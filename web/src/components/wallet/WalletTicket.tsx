// The paper "corner pass" a connected NEAR wallet gets before its one approval: who is connected, how much fight money to
// deposit, and exactly what the wallet will be asked to sign.
import { useEffect, useState } from 'react'
import { Icon } from '../Icon'
import type { Connected } from '../../game/wallet/connector'
import { near } from '../../lib/format'
import './wallet.css'

const NEAR = 10n ** 24n
const CHOICES = [NEAR / 10n, NEAR / 5n, NEAR / 2n, NEAR]
const DEFAULT = NEAR / 5n
const HEADROOM = NEAR / 20n
const FAUCET = 'https://near-faucet.io/'

/** The NEAR "N" mark (NEAR Connect's own logo path), drawn in the current text colour. */
export function NearMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="96 96 320 320" aria-hidden="true" fill="currentColor">
      <path d="M373.89 106.199a31.95 31.95 0 0 0-27.213 15.207l-62.631 92.979a6.67 6.67 0 0 0 9.88 8.742l61.643-53.47c1.02-.924 2.599-.827 3.523.193.419.473.644 1.074.644 1.697v167.402a2.49 2.49 0 0 1-2.502 2.491 2.48 2.48 0 0 1-1.912-.891L168.976 117.497a31.93 31.93 0 0 0-24.356-11.298h-6.508c-17.623 0-31.917 14.294-31.917 31.917v235.767c0 17.623 14.294 31.917 31.917 31.917a31.94 31.94 0 0 0 27.213-15.206l62.631-92.98a6.66 6.66 0 0 0-1.847-9.236 6.67 6.67 0 0 0-8.033.494l-61.643 53.471c-1.02.923-2.599.826-3.522-.194a2.5 2.5 0 0 1-.634-1.697V173.008a2.49 2.49 0 0 1 2.502-2.492c.731 0 1.439.322 1.912.891l186.313 223.096a31.95 31.95 0 0 0 24.357 11.297h6.508c17.623 0 31.927-14.272 31.938-31.895V138.116c0-17.623-14.294-31.917-31.917-31.917" />
    </svg>
  )
}

interface Funds { spendable: bigint; inGame: bigint }

export function WalletTicket({ connected, amount, onAmount, locked, onSwitch }: { connected: Connected; amount: bigint | null; onAmount: (a: bigint | null) => void; locked: boolean; onSwitch: () => void }) {
  const [funds, setFunds] = useState<Funds | null>(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setFailed(false)
    void (async () => {
      try {
        const [{ walletBalance }, { Rpc }, { rpcUrls, contractId }] = await Promise.all([import('../../game/wallet/setup'), import('../../game/chain/rpc'), import('../../game/wallet/connector')])
        const rpc = new Rpc({ urls: rpcUrls() })
        const [spendable, inGame] = await Promise.all([walletBalance(connected.accountId, rpc), rpc.view<string>(contractId(), 'balance_of', { account: connected.accountId }).then((b) => BigInt(String(b ?? '0')), () => 0n)])
        if (!live) return
        setFunds({ spendable, inGame })
        const fits = CHOICES.filter((c) => c + HEADROOM <= spendable)
        onAmount(fits.includes(DEFAULT) ? DEFAULT : fits.length ? fits[fits.length - 1]! : inGame > 0n ? 0n : null)
      } catch { if (live) setFailed(true) }
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected.accountId, tick])

  const empty = funds && !CHOICES.some((c) => c + HEADROOM <= funds.spendable)
  return (
    <section className="wt paper" aria-label="Your wallet corner pass">
      <header className="wt-head">
        <span className="wt-eyebrow">Corner pass · NEAR testnet</span>
        <button className="wt-switch" onClick={onSwitch} disabled={locked}>Switch wallet</button>
      </header>
      <div className="wt-who">
        <span className="wt-mark"><NearMark size={22} /></span>
        <div className="wt-id">
          <strong className={`display ${connected.accountId.length > 22 ? 'is-long' : ''}`} title={connected.accountId}>{connected.accountId}</strong>
          <small>via {connected.walletName}{funds ? ` · ${near(funds.spendable, 2)} NEAR free` : failed ? '' : ' · checking balance…'}</small>
        </div>
      </div>
      <div className="wt-perf" aria-hidden="true" />
      {failed ? (
        <p className="wt-msg" role="alert">Could not read this account on NEAR testnet. <button className="wt-link" onClick={() => setTick((t) => t + 1)}>Try again</button></p>
      ) : empty && amount === null ? (
        <p className="wt-msg" role="status">This wallet holds {near(funds!.spendable, 3)} NEAR on testnet: not enough for fight money and gas. Get free testnet NEAR at <a href={FAUCET} target="_blank" rel="noreferrer">near-faucet.io <Icon name="external" size={11} /></a>, then <button className="wt-link" onClick={() => setTick((t) => t + 1)}>check again</button>.</p>
      ) : (
        <>
          <div className="wt-row">
            <span className="wt-label">Fight money</span>
            <div className="wt-chips" role="radiogroup" aria-label="Fight money to deposit">
              {funds && funds.inGame > 0n && (
                <button role="radio" aria-checked={amount === 0n} className={`wt-chip ${amount === 0n ? 'is-on' : ''}`} disabled={locked} onClick={() => onAmount(0n)}>None</button>
              )}
              {CHOICES.map((c) => {
                const off = !funds || c + HEADROOM > funds.spendable
                return <button key={String(c)} role="radio" aria-checked={amount === c} className={`wt-chip num ${amount === c ? 'is-on' : ''}`} disabled={locked || off} onClick={() => onAmount(c)}>{near(c, 2)}</button>
              })}
              <span className="wt-unit">NEAR</span>
            </div>
          </div>
          <ol className="wt-steps">
            <li><b>1</b><span>Adds a session key to <i>{connected.accountId}</i> that can only call <i>challenge</i> on the game contract (gas allowance 0.25 NEAR). It can never withdraw or move a belt.</span></li>
            <li><b>2</b><span>{amount && amount > 0n ? <>Deposits <i className="num">{near(amount, 2)} NEAR</i> as fight money. Withdraw it any time from the account menu.</> : <>No deposit: you already have <i className="num">{near(funds?.inGame ?? 0n, 3)} NEAR</i> in the ring.</>}</span></li>
          </ol>
        </>
      )}
    </section>
  )
}
