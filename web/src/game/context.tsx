import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GameClient } from './client'
import { MockClient } from './mock'
import type { Account } from './types'

interface Ctx {
  client: GameClient
  account: Account | null
  ready: boolean
  refreshAccount: () => Promise<void>
  setAccount: (a: Account | null) => void
  /** sentence carried from the Corner into the Bout screen */
  pending: { beltId: string; sentence: string } | null
  setPending: (p: { beltId: string; sentence: string } | null) => void
}

const GameCtx = createContext<Ctx | null>(null)

let singleton: GameClient | null = null
function makeClient(): GameClient {
  if (!singleton) singleton = new MockClient()
  return singleton
}

export function GameProvider({ children, client: injected }: { children: ReactNode; client?: GameClient }) {
  const client = useMemo(() => injected ?? makeClient(), [injected])
  const [account, setAccount] = useState<Account | null>(null)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<Ctx['pending']>(null)
  const refreshAccount = useCallback(async () => {
    try { setAccount(await client.account()) } finally { setReady(true) }
  }, [client])
  useEffect(() => { void refreshAccount() }, [refreshAccount])
  const value = useMemo(() => ({ client, account, ready, refreshAccount, setAccount, pending, setPending }), [client, account, ready, refreshAccount, pending])
  return <GameCtx.Provider value={value}>{children}</GameCtx.Provider>
}

export function useGame(): Ctx {
  const c = useContext(GameCtx)
  if (!c) throw new Error('useGame outside GameProvider')
  return c
}

/** Tiny async-data hook with loading / error / reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => { if (live) setState({ data, error: null, loading: false }) },
      (e: unknown) => { if (live) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }) },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { ...state, reload: () => setTick((t) => t + 1) }
}
