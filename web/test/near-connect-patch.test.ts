import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

// The pnpm patch (patches/@hot-labs__near-connect@0.12.0.patch) makes NEAR Connect open web wallets such as Meteor web as a
// tab in the same window: window.open(url, "_blank") with no window features, and with the opener kept.
const require = createRequire(import.meta.url)

type Fake = { open: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }

describe('NEAR Connect opens a web wallet as a tab, not a popup window', () => {
  const g = globalThis as unknown as { window?: Fake }
  const before = g.window
  afterEach(() => { g.window = before; vi.useRealTimers() })

  it('the executor calls window.open(url, "_blank") with no features, even when the wallet asks for a sized popup', async () => {
    vi.useFakeTimers()
    const panel = { closed: false }
    g.window = { open: vi.fn(() => panel), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const SandboxExecutor = require('@hot-labs/near-connect/build/SandboxedWallet/executor.js').default
    const executor = new SandboxExecutor({}, { id: 'meteor-wallet', permissions: { allowsOpen: ['https://wallet.meteorwallet.app'] } })
    const iframe = { postMessage: vi.fn(), show: vi.fn(), hide: vi.fn() }
    const url = 'https://wallet.meteorwallet.app/connect/testnet'
    await executor._onMessage(iframe, { data: { method: 'open', params: { url, features: 'popup=1,width=420,height=640' } } })

    expect(g.window.open).toHaveBeenCalledTimes(1)
    expect(g.window.open.mock.calls[0]).toEqual([url, '_blank'])
    // the opener relationship is kept: no noopener/noreferrer sneaks in through a third argument
    expect(g.window.open.mock.calls[0]).toHaveLength(2)
    // the panel is tracked, so closing the wallet tab without approving reaches the wallet as proxy-window:closed
    expect(iframe.postMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
    panel.closed = true
    vi.advanceTimersByTime(600)
    expect(iframe.postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'proxy-window:closed' }))
  })

  it('a URL the wallet manifest does not allow is still refused (the patch changes nothing else)', async () => {
    g.window = { open: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const SandboxExecutor = require('@hot-labs/near-connect/build/SandboxedWallet/executor.js').default
    const executor = new SandboxExecutor({}, { id: 'meteor-wallet', permissions: { allowsOpen: ['https://wallet.meteorwallet.app'] } })
    const iframe = { postMessage: vi.fn(), show: vi.fn(), hide: vi.fn() }
    await expect(executor._onMessage(iframe, { data: { method: 'open', params: { url: 'https://evil.example/x' } } })).rejects.toThrow('Permission denied')
    expect(g.window.open).not.toHaveBeenCalled()
  })
})
