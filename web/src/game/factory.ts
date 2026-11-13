// Picks the client: NearClient when the contract id is configured, MockClient for ?mock=1 / VITE_MODE=mock or no contract.
import type { GameClient } from './client'
import { MockClient } from './mock'
import { NearClient } from './near'

const MOCK_FLAG = 'ts-mock'

/** `?mock=1` forces the offline demo (kept for the tab session); `?mock=0` clears it. */
export function wantsMock(search: string, mode: string | undefined, contractId: string | undefined, session: { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }): boolean {
  const q = new URLSearchParams(search).get('mock')
  if (q === '1') { session.set(MOCK_FLAG, '1'); return true }
  if (q === '0') { session.remove(MOCK_FLAG); return !contractId || mode === 'mock' }
  return mode === 'mock' || !contractId || session.get(MOCK_FLAG) === '1'
}

function sessionStore() {
  return {
    get(k: string) { try { return sessionStorage.getItem(k) } catch { return null } },
    set(k: string, v: string) { try { sessionStorage.setItem(k, v) } catch { /* private window */ } },
    remove(k: string) { try { sessionStorage.removeItem(k) } catch { /* private window */ } },
  }
}

export function makeClient(): GameClient {
  const env = import.meta.env as Record<string, string | undefined>
  const contractId = (env.VITE_CONTRACT_ID ?? '').trim() || undefined
  if (wantsMock(location.search, env.VITE_MODE, contractId, sessionStore())) return new MockClient()
  const rpcUrls = (env.VITE_NEAR_RPC ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return new NearClient({ contractId: contractId!, rpcUrls: rpcUrls.length ? rpcUrls : undefined, apiBase: env.VITE_API_BASE ?? '' })
}
