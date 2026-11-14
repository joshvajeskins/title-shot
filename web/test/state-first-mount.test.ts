// First mount of /play: the belts must not wait on the fight-engine wasm, and a stalled /api/state is retried.
// Regression for a fresh load that sat on skeleton belts for >30 s with /api/state never requested.
import { describe, expect, it, vi } from 'vitest'
import { belt, CONTRACT } from './fixtures'
import { sim } from './helpers'
import { mapBelt } from '../src/game/chain/views'
import { NearClient } from '../src/game/near'
import type { KeyStore } from '../src/game/nearKeys'

// The wasm fetch stalls (a cold cache on a slow edge): loadSim never settles.
vi.mock('../src/sim', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/sim')>()), loadSim: () => new Promise(() => undefined) }))

const store: KeyStore = { get: () => null, set: () => undefined, remove: () => undefined }
const stateJson = () => ({ at: 1, contract: CONTRACT, forgeMode: 'relayer', model: 'm', rulebookHash: sim().rulebook().hash, belts: [mapBelt(belt(), sim().rulebook())], fights: [], payouts: [], wallets: [], tick: null })

/** Fails the test in `ms` instead of letting a hung promise run into the suite timeout. */
const inTime = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`still waiting after ${ms} ms`)), ms))])

function client(answer: (n: number) => Promise<Response>) {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    const path = new URL(url, 'https://t.test').pathname
    calls.push(path)
    if (path === '/api/state') return answer(calls.filter((c) => c === path).length)
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  const c = new NearClient({ contractId: CONTRACT, fetchFn, store, sleep: async () => undefined, stateTimeoutMs: 150, simWaitMs: 50 } as ConstructorParameters<typeof NearClient>[0])
  return { c, calls }
}

describe('belts on first mount', () => {
  it('asks /api/state at once and renders its belts even while the wasm never loads', async () => {
    const { c, calls } = client(async () => new Response(JSON.stringify(stateJson())))
    const belts = await inTime(c.belts(), 1500)
    expect(calls).toContain('/api/state')
    expect(belts.map((b) => b.name)).toEqual(['The Midnight Belt'])
  })

  it('a stalled /api/state times out and the retry answers', async () => {
    const { c, calls } = client(async (n) => (n === 1 ? new Promise<Response>(() => undefined) : new Response(JSON.stringify(stateJson()))))
    const belts = await inTime(c.belts(), 1500)
    expect(calls.filter((p) => p === '/api/state').length).toBe(2)
    expect(belts).toHaveLength(1)
  })
})
