// React state for the payout dialog's "connect a wallet" path: discovered wallets, the flow's step, its outcome, and the
// wallet's account changes after linking.
import { useCallback, useEffect, useRef, useState } from 'react'
import { watchWallets, type WalletHost } from './discover'
import { linkWallet, revoke, type LinkStep } from './link'
import { WalletError, type WalletOption } from './types'

export type WalletPhase =
  | { phase: 'idle' }
  | { phase: 'busy'; wallet: WalletOption; step: LinkStep }
  | { phase: 'linked'; wallet: WalletOption; address: string; switched: boolean }
  | { phase: 'error'; wallet: WalletOption; error: WalletError }

/** How long the dialog says "looking for wallets" before it concludes there are none. */
const DISCOVERY_MS = 600

export function useWalletLink(nearAccount: string | null) {
  const [wallets, setWallets] = useState<WalletOption[]>([])
  const [discovering, setDiscovering] = useState(true)
  const [state, setState] = useState<WalletPhase>({ phase: 'idle' })
  const flow = useRef<AbortController | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') { setDiscovering(false); return }
    const w = watchWallets(window as unknown as WalletHost, setWallets)
    const t = setTimeout(() => setDiscovering(false), DISCOVERY_MS)
    return () => { w.stop(); clearTimeout(t); flow.current?.abort() }
  }, [])

  const connect = useCallback(async (wallet: WalletOption) => {
    flow.current?.abort()
    const ctl = new AbortController()
    flow.current = ctl
    if (!nearAccount) { setState({ phase: 'error', wallet, error: new WalletError('failed', 'Make a corner first: the wallet links to your NEAR account.') }); return }
    setState({ phase: 'busy', wallet, step: 'connecting' })
    try {
      const r = await linkWallet({
        provider: wallet.provider, nearAccount, domain: window.location.host, signal: ctl.signal,
        onStep: (step) => { if (flow.current === ctl) setState({ phase: 'busy', wallet, step }) },
      })
      if (flow.current === ctl) setState({ phase: 'linked', wallet, address: r.address, switched: r.switched })
    } catch (e) {
      if (flow.current !== ctl) return
      const error = e instanceof WalletError ? e : new WalletError('failed', 'The wallet returned an error.')
      setState(error.kind === 'cancelled' ? { phase: 'idle' } : { phase: 'error', wallet, error })
    }
  }, [nearAccount])

  const cancel = useCallback(() => { flow.current?.abort(); flow.current = null; setState({ phase: 'idle' }) }, [])

  const disconnect = useCallback(() => {
    if (state.phase === 'linked' || state.phase === 'error') void revoke(state.wallet.provider)
    cancel()
  }, [state, cancel])

  // once linked, a different account in the wallet means the signature no longer speaks for what it shows
  const linked = state.phase === 'linked' ? state : null
  useEffect(() => {
    if (!linked?.wallet.provider.on) return
    const p = linked.wallet.provider
    const onAccounts = (accounts: unknown) => {
      const next = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null
      if (next === linked.address) return
      setState(next
        ? { phase: 'error', wallet: linked.wallet, error: new WalletError('account-changed', 'The wallet changed accounts.', { from: linked.address, to: next }) }
        : { phase: 'idle' })
    }
    p.on!('accountsChanged', onAccounts)
    return () => { p.removeListener?.('accountsChanged', onAccounts) }
  }, [linked])

  return { wallets, discovering: discovering && wallets.length === 0, state, connect, cancel, disconnect }
}
