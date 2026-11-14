// A closed season -> the UI's `Bell` (the purse cinematic). Pure: payout tracking comes in as plain data.
import type { Bell, PayoutRow } from '../types'
import { baseTxUrl } from './config'
import { nsToMs, type RawPayout, type RawSeason } from './views'

export type PayoutStatus = 'claimable' | 'unsigned' | 'signing' | 'signed' | 'sent' | 'mined' | 'reverted'
export interface PayoutTrackLite { hash: string; status: 'sent' | 'mined' | 'reverted' }

export function payoutStatus(p: RawPayout, tracked: PayoutTrackLite | null): PayoutStatus {
  if (!p.to) return 'claimable'
  if (p.raw_tx && tracked) return tracked.status
  if (p.raw_tx) return 'signed'
  return p.signing ? 'signing' : 'unsigned'
}

const UI_STATUS: Record<PayoutStatus, PayoutRow['status']> = {
  claimable: 'unclaimed', unsigned: 'unsigned', signing: 'unsigned', signed: 'signed', sent: 'signed', mined: 'mined', reverted: 'signed',
}

/** First DNS label of a NEAR account: "otto-ink.testnet" -> "otto-ink". */
export const displayName = (account: string): string => account.split('.')[0] ?? account

export function mapBell(season: RawSeason, payouts: RawPayout[], tracks: Map<number, PayoutTrackLite | null>, promoter: string): Bell | null {
  if (season.state !== 'Closed' || !season.final_holder) return null
  const defences = new Map(season.defence_count.map((d) => [d.account, d.defences]))
  const rows: PayoutRow[] = payouts.map((p) => {
    const st = payoutStatus(p, tracks.get(p.id) ?? null)
    const tx = tracks.get(p.id)?.hash
    const share: PayoutRow['share'] = p.payee === season.final_holder ? 'holder' : season.bouts === 0 && p.payee === promoter ? 'refund' : 'defences'
    return {
      id: p.id, payee: p.payee, name: displayName(p.payee), share, ...(share === 'defences' ? { defences: defences.get(p.payee) ?? 0 } : {}),
      amountWei: p.amount_wei, status: UI_STATUS[st], ...(tx ? { tx, explorer: baseTxUrl(tx) } : {}), ...(p.to ? { to: p.to } : {}),
    }
  })
  return {
    seasonId: season.id, at: nsToMs(season.closes_at), holder: season.final_holder, holderName: displayName(season.final_holder),
    purseWei: season.purse.amount_wei, sidePotYocto: season.side_pot, payouts: rows,
  }
}
