// "Add fight money" for a wallet account: one tap on an amount goes straight to the wallet (`deposit` on the contract), with
// no network wait first (a web wallet's sign tab is opened with window.open, which needs a recent tap; Shell prewarms the
// wallet and the call module). The wallet's own approval screen is the confirmation.
import { useState } from 'react'
import { sound } from '../../audio/sound'
import { txUrl } from '../../game/chain/config'
import { useGame } from '../../game/context'
import { near } from '../../lib/format'
import { Icon } from '../Icon'
import './wallet.css'

const NEAR = 10n ** 24n
export const TOP_UP_CHOICES = [NEAR / 10n, NEAR / 5n, NEAR / 2n] as const

export function TopUp({ label = 'Add fight money', onDone }: { label?: string; onDone?: () => void }) {
  const { client, refreshAccount } = useGame()
  const [busy, setBusy] = useState<bigint | null>(null)
  const [note, setNote] = useState<{ text: string; tx?: string; bad?: boolean } | null>(null)
  if (!client.deposit) return null
  const add = async (yocto: bigint) => {
    if (busy !== null || !client.deposit) return
    setBusy(yocto); setNote({ text: `Approve ${near(yocto, 2)} NEAR in your wallet.` }); sound.play('ui_confirm')
    try {
      const tx = await client.deposit(yocto)
      setNote({ text: `Added ${near(yocto, 2)} NEAR to your fight money.`, tx }); sound.play('kaching')
      await refreshAccount()
      onDone?.()
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'The deposit did not go through.', bad: true }); sound.play('ui_error')
    } finally { setBusy(null) }
  }
  return (
    <div className="tu">
      <span className="tu-label"><Icon name="coin" size={14} /> {label}</span>
      <div className="tu-chips" role="group" aria-label={label}>
        {TOP_UP_CHOICES.map((c) => (
          <button key={String(c)} type="button" className={`tu-chip num ${busy === c ? 'is-busy' : ''}`} disabled={busy !== null} onClick={() => void add(c)}>
            +{near(c, 2)}
          </button>
        ))}
        <span className="tu-unit">NEAR</span>
      </div>
      {note && (
        <p className={`tu-note ${note.bad ? 'is-bad' : ''}`} role={note.bad ? 'alert' : 'status'}>
          {note.text}{note.tx && <> <a href={txUrl(note.tx)} target="_blank" rel="noreferrer">View tx <Icon name="external" size={10} /></a></>}
        </p>
      )}
    </div>
  )
}
