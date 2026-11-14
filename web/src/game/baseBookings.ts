// Title shots bought on Base over x402 (functions/api/boxoffice/recent): corner account → who paid on Base.
// Cached for 30 s per page; an unreachable endpoint (or the demo build) means "none", never an error.
import { shortHex } from '../lib/format'

let cached: { at: number; p: Promise<Map<string, string>> } | null = null

export function baseBookings(clientMode: 'mock' | 'testnet'): Promise<Map<string, string>> {
  if (clientMode === 'mock') return Promise.resolve(new Map())
  if (cached && Date.now() - cached.at < 30_000) return cached.p
  const p = fetch('/api/boxoffice/recent')
    .then((r) => (r.ok ? r.json() : { bookings: [] }))
    .then((j: { bookings?: { guest: string; payer: string; payerName: string | null }[] }) =>
      new Map((j.bookings ?? []).map((b) => [b.guest, b.payerName ?? shortHex(b.payer)] as const)))
    .catch(() => new Map<string, string>())
  cached = { at: Date.now(), p }
  return p
}
