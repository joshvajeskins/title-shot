import { lazy, Suspense, useState } from 'react'
import { sound } from '../../audio/sound'
import { BaseName } from '../../components/BaseName'
import { Icon } from '../../components/Icon'
import { Link } from '../../components/Link'
import { PayoutAddressDialog } from '../../components/PayoutAddress'
import { TopUp } from '../../components/wallet/TopUp'
import { txUrl } from '../../game/chain/config'
import { useGame } from '../../game/context'
import type { CornerData } from '../../game/corner/load'
import { nearEarned, totalRecord, recordsOf } from '../../game/corner/derive'
import { eth, near, personaOf, shortHex } from '../../lib/format'

const MoveDialog = lazy(() => import('../../components/wallet/MoveDialog').then((m) => ({ default: m.MoveDialog })))

/** The big name on the file: a persona, the first label of a named account, or a short hex for an implicit / 0x account. */
export function fileName(id: string): string {
  if (personaOf(id)) return personaOf(id)!
  if (/^0x[0-9a-f]{40}$/i.test(id) || /^[0-9a-f]{64}$/.test(id)) return shortHex(id.startsWith('0x') ? id : `0x${id}`, 4)
  return id.split('.')[0] ?? id
}

export type Viewer = { kind: 'self'; wallet: boolean } | { kind: 'visitor' }

export function Header({ data, viewer, onChanged }: { data: CornerData; viewer: Viewer; onChanged: () => void }) {
  const rec = totalRecord(recordsOf(data.bouts))
  const purseWei = data.payouts.reduce((s, p) => s + p.amountWei, 0n)
  const self = viewer.kind === 'self'
  return (
    <header className="mc-head">
      <div className="mc-file paper">
        <span className="mc-file-tab">Corner file · <b>NEAR testnet</b></span>
        <div className="mc-who">
          <span className="eyebrow">{self ? 'Fighter on file: you' : 'Fighter on file'}</span>
          <h1 className="display mc-name" title={data.account}>{fileName(data.account)}</h1>
          <div className="mc-id">
            <span className="num">{data.account}</span>
            {self && <span className={`mc-kind ${viewer.wallet ? 'is-wallet' : ''}`}>{viewer.wallet ? 'NEAR wallet' : 'Judge demo, not a wallet'}</span>}
            {!self && <span className="mc-kind">Read-only view</span>}
          </div>
        </div>
        <dl className="mc-ledger">
          <div><dt>Record W-L-D</dt><dd className="num">{rec.w}-{rec.l}-{rec.d}</dd></div>
          <div><dt>Belts held</dt><dd className="num">{data.held.length}</dd></div>
          <div><dt>NEAR earned</dt><dd className="num">{near(nearEarned(data.earnings), 4)}</dd></div>
          <div><dt>Purse on Base</dt><dd className="num">{eth(purseWei, 4)} <small>ETH</small></dd></div>
        </dl>
        {!self && <p className="mc-view-note">Someone else's corner, read from the chain. Nothing here can be changed. <Link href="/play/me">Open your own corner</Link></p>}
      </div>
      <Money data={data} viewer={viewer} onChanged={onChanged} />
    </header>
  )
}

function Money({ data, viewer, onChanged }: { data: CornerData; viewer: Viewer; onChanged: () => void }) {
  const { account, client, refreshAccount } = useGame()
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; tx?: string; bad?: boolean } | null>(null)
  const self = viewer.kind === 'self'
  const wallet = self && viewer.wallet
  // the context balance follows deposits and withdrawals at once; a visitor sees the chain read
  const balance = self && account ? BigInt(account.balanceYocto) : data.balanceYocto
  const live = client.mode === 'testnet'
  const withdraw = async () => {
    if (!client.withdraw || busy) return
    setBusy(true); setMsg({ text: 'Approve the withdrawal in your wallet.' })
    try {
      const tx = await client.withdraw()
      setMsg({ text: `Withdrawn to ${data.account}.`, tx }); sound.play('kaching')
      await refreshAccount(); onChanged()
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : 'The withdrawal did not go through.', bad: true }); sound.play('ui_error') }
    finally { setBusy(false) }
  }
  return (
    <section className="mc-money panel" aria-label="Fight money">
      <span className="eyebrow">Fight money · game balance</span>
      <div className="mc-money-bal">
        <b className="num">{near(balance, 4)} <small>NEAR</small></b>
        <small>Held by the contract: tolls come out of it, and the champion's share and side-pots land in it.</small>
      </div>
      {self && live && (
        <div className="mc-actions">
          {wallet && balance > 0n && <button className="btn btn-ghost btn-sm" onClick={withdraw} disabled={busy}><Icon name="coin" size={15} /> {busy ? 'Waiting for wallet…' : `Withdraw ${near(balance, 3)}`}</button>}
          {!wallet && <button className="btn btn-ghost btn-sm" onClick={() => setMoveOpen(true)}><Icon name="arrow" size={15} /> Move to my wallet</button>}
        </div>
      )}
      {wallet && live && <TopUp onDone={onChanged} />}
      {!wallet && self && live && <p className="mc-note">A demo account cannot take deposits from a wallet. <b>Move to my wallet</b> sends its balance, belts and NEAR to a wallet you connect.</p>}
      {msg && <p className={`mc-msg ${msg.bad ? 'is-bad' : ''}`} role={msg.bad ? 'alert' : 'status'}>{msg.text}{msg.tx && <> <a className="mc-link" href={txUrl(msg.tx)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={10} /></a></>}</p>}
      <div className="mc-addr">
        <span className="eyebrow">Purse payout address · Base Sepolia</span>
        <div className="mc-addr-row">
          {data.payoutAddress ? <BaseName address={data.payoutAddress} chars={6} link /> : <span className="mc-addr-none">None on file</span>}
          {self && live && <button className="mc-link" onClick={() => setPayoutOpen(true)}>{data.payoutAddress ? 'Edit' : 'Set one'} <Icon name="arrow" size={11} /></button>}
        </div>
        {!data.payoutAddress && <p className="mc-note">Without one, a purse share waits at the bell until {self ? 'you claim' : 'its owner claims'} it with an address.</p>}
      </div>
      {payoutOpen && <PayoutAddressDialog onClose={() => { setPayoutOpen(false); onChanged() }} />}
      {moveOpen && <Suspense fallback={null}><MoveDialog onClose={() => { setMoveOpen(false); void refreshAccount(); onChanged() }} /></Suspense>}
    </section>
  )
}
