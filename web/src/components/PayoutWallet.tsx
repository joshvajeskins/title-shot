import { errorCopy, stepCopy } from '../game/evm/copy'
import type { LinkStep } from '../game/evm/link'
import type { WalletOption } from '../game/evm/types'
import type { useWalletLink } from '../game/evm/useWalletLink'
import { NameLabel, useBaseName } from './BaseName'
import { Icon } from './Icon'
import './payout-wallet.css'

type Link = ReturnType<typeof useWalletLink>

/** A wallet's own icon from its EIP-6963 announcement, or its initial. */
function WalletMark({ wallet, size = 28 }: { wallet: WalletOption; size?: number }) {
  return wallet.info.icon
    ? <img className="pw-mark" src={wallet.info.icon} alt="" width={size} height={size} />
    : <span className="pw-mark pw-mark-none" style={{ width: size, height: size }} aria-hidden="true">{wallet.info.name.slice(0, 1).toUpperCase()}</span>
}

const ROUNDS: { step: LinkStep; label: string }[] = [
  { step: 'connecting', label: 'Connect' },
  { step: 'switching', label: 'Base Sepolia' },
  { step: 'signing', label: 'Sign' },
]
const ORDER: LinkStep[] = ['connecting', 'switching', 'signing', 'verifying']

function Rounds({ step }: { step: LinkStep }) {
  const at = ORDER.indexOf(step)
  return (
    <ol className="pw-rounds">
      {ROUNDS.map((r, i) => (
        <li key={r.step} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
          <span className="pw-rd">Rd {i + 1}</span>
          <span className="pw-rd-label">{i < at ? <Icon name="check" size={12} stroke={2.4} /> : null}{r.label}</span>
        </li>
      ))}
    </ol>
  )
}

/** The verified address, named by its Basename when it has one. */
function Linked({ wallet, address, onDisconnect, onFile }: { wallet: WalletOption; address: string; onDisconnect: () => void; onFile: boolean }) {
  const name = useBaseName(address)
  return (
    <div className="pa-target pw-linked">
      <div className="pw-linked-head">
        <span className="eyebrow">Pays to</span>
        <span className="chip chip-gold pw-proof"><Icon name="check" size={12} stroke={2.4} /> signed in {wallet.info.name}</span>
      </div>
      {name ? <b className="pa-target-name"><NameLabel name={name} /></b> : <span className="pa-target-none">no Basename</span>}
      <code className="pa-target-addr">{address}</code>
      <div className="pw-linked-foot">
        <span className="pw-wallet-tag"><WalletMark wallet={wallet} size={18} /> {onFile ? 'Already on file for your corner.' : 'Your signature proves it is yours.'}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDisconnect}>Disconnect</button>
      </div>
    </div>
  )
}

/** The "connect a wallet" path of the payout dialog. */
export function PayoutWallet({ link, onPaste, onFile }: { link: Link; onPaste: () => void; onFile: (address: string) => boolean }) {
  const { wallets, discovering, state, connect, cancel, disconnect } = link
  if (state.phase === 'linked') return <Linked wallet={state.wallet} address={state.address} onDisconnect={disconnect} onFile={onFile(state.address)} />
  if (state.phase === 'busy') {
    return (
      <div className="pw-card pw-busy" aria-live="polite">
        <div className="pw-who"><WalletMark wallet={state.wallet} /> <b className="pw-name">{state.wallet.info.name}</b></div>
        <Rounds step={state.step} />
        <p className="pa-looking"><span className="pa-dot" /> {stepCopy(state.step, state.wallet.info.name)}</p>
        <div className="pw-row"><button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button></div>
      </div>
    )
  }
  if (state.phase === 'error') {
    const c = errorCopy(state.error, state.wallet.info.name)
    return (
      <div className="pw-card pw-error" role="alert">
        <div className="pw-who"><WalletMark wallet={state.wallet} /> <b className="display pw-title">{c.title}</b></div>
        <p>{c.body}</p>
        {c.hint && <p className="pa-note">{c.hint}</p>}
        <div className="pw-row">
          <button type="button" className="btn btn-gold btn-sm" onClick={() => void connect(state.wallet)}>{c.retry}</button>
          {wallets.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Choose another wallet</button>}
          <button type="button" className="pw-link" onClick={onPaste}>Paste an address instead</button>
        </div>
      </div>
    )
  }
  if (discovering) return <p className="pa-looking pw-card"><span className="pa-dot" /> Looking for wallets in this browser…</p>
  if (!wallets.length) {
    return (
      <div className="pw-card pw-none">
        <b className="display pw-title">No wallet in this browser</b>
        <p>Connecting needs a browser wallet extension, such as MetaMask, Rabby or Coinbase Wallet, or this page opened inside a wallet app's browser.</p>
        <p>Know your address already? Paste it, or your Basename: the purse pays it the same way.</p>
        <div className="pw-row"><button type="button" className="btn btn-gold btn-sm" onClick={onPaste}>Paste an address <Icon name="arrow" size={14} /></button></div>
      </div>
    )
  }
  return (
    <div className="pw-list">
      <ul>
        {wallets.map((w) => (
          <li key={w.info.uuid}>
            <button type="button" className="pw-wallet" onClick={() => void connect(w)}>
              <WalletMark wallet={w} />
              <span className="pw-wallet-name">{w.info.name}</span>
              <span className="pw-wallet-go">Connect <Icon name="arrow" size={14} /></span>
            </button>
          </li>
        ))}
      </ul>
      <p className="pa-note">Your wallet signs one short message, free and with no transaction, proving the address is yours before it is saved.</p>
    </div>
  )
}
