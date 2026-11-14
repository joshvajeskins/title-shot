// The stand-in wired into the Worker: preview, the relayer sweep and the opener, with the same checks the contract makes.
import { describe, expect, it } from 'vitest'
import { env, sim } from './helpers'
import { run, setup, world } from './tick-rig'
import { challenge, ns, NOW_MS } from './fixtures'
import { runPreview } from '../functions/_lib/preview'
import { standinAddress, STANDIN_MODEL } from '../functions/_lib/standin'
import { verifySigned } from '../src/game/chain/signature'
import { utf8 } from '../src/game/chain/bytes'
import { STANDIN_OPENERS } from '../functions/_lib/standinSpec'
import { belt, season } from './fixtures'
import type { Chain } from '../functions/_lib/chain'
import { clearMemoryCache } from '../functions/_lib/cache'

const KEY = '0x' + '7c'.repeat(32)
const standinEnv = () => env({ COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: KEY })
const offline = (async () => { throw new Error('the network must not be touched in stand-in mode') }) as unknown as typeof fetch

describe('POST /api/preview in stand-in mode', () => {
  it('returns a stand-in compile flagged compiler:standin, verified, with no network call', async () => {
    const r = await runPreview({ env: standinEnv(), sim: sim(), chain: null, fetchFn: offline }, 'a very polite kraken')
    expect(r).toMatchObject({ canonical: false, compiler: 'standin', verified: true, signer: standinAddress(KEY), spec: { name: 'Sir Squidley' } })
    expect(r.signature!.kind).toBe('provider_tee')
    expect(r.attested).toBeNull() // no contract to check the allowlist against
  })
  it('a non-roster sentence is built from its own words and still normalizes', async () => {
    const r = await runPreview({ env: standinEnv(), sim: sim(), chain: null, fetchFn: offline }, 'an accountant who is secretly a thunderstorm')
    expect(r.compiler).toBe('standin')
    expect(r.spec.name).toBe('Accountant Secretly')
    expect(r.spec.moves).toHaveLength(3)
    expect(r.requestSha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('the contract decides "attested": allowlist holding the stand-in address and provider_tee kind gives true, else false', async () => {
    const chain = (list: string[], kind: string) => ({
      fighterBySentence: async () => null,
      config: async () => ({ model_id: STANDIN_MODEL, signature_kind: kind }),
      allowlist: async () => ({ active: list, pending: null }),
    }) as unknown as Chain
    const ok = await runPreview({ env: standinEnv(), sim: sim(), chain: chain([standinAddress(KEY)], 'provider_tee'), fetchFn: offline }, 'a goose with a mortgage')
    expect(ok.attested).toBe(true)
    clearMemoryCache()
    const bad = await runPreview({ env: standinEnv(), sim: sim(), chain: chain(['0x' + '00'.repeat(20)], 'provider_tee'), fetchFn: offline }, 'a goose with a mortgage again')
    expect(bad.attested).toBe(false)
  })
  it('without the key and without NEAR AI the preview is a clean 503, not a crash', async () => {
    await expect(runPreview({ env: env({ COMPILER_MODE: 'standin' }), sim: sim(), chain: null, fetchFn: offline }, 'a goose with a mortgage')).rejects.toMatchObject({ status: 503, code: 'STANDIN_NO_KEY' })
  })
  it('a cached stand-in preview is not reused once a real NEAR AI key is configured', async () => {
    const e = standinEnv()
    const a = await runPreview({ env: e, sim: sim(), chain: null, fetchFn: offline }, 'a goose with a mortgage')
    expect(a.compiler).toBe('standin')
    const same = await runPreview({ env: e, sim: sim(), chain: null, fetchFn: offline }, 'a goose with a mortgage')
    expect(same).toEqual(a) // cache hit
    e.NEARAI_API_KEY = 'k'
    await expect(runPreview({ env: e, sim: sim(), chain: null, fetchFn: offline }, 'a goose with a mortgage')).rejects.toBeDefined() // went to NEAR AI (offline here), not the cache
  })
})

describe('the relayer sweep submits stand-in forges', () => {
  const forging = (over = {}) => challenge({ id: 0, created_at: ns(NOW_MS - 5000), relayer: true, need_compile: true, sentence: 'a skeleton who is late for work', ...over })
  it('submit_forge carries a response and signature the contract would accept for the stand-in address', async () => {
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging() } })
    const { d, calls } = setup(w, { relayer: true, fetchFn: offline })
    Object.assign(d.env, { COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: KEY })
    d.chain.config = (async () => ({ model_id: STANDIN_MODEL, forge_mode: 'relayer' })) as never
    await run(d)
    const sub = calls.find((c) => c.method === 'submit_forge')!
    expect(sub.who).toBe('relay.titleshot.testnet')
    const out = JSON.parse(sub.args.output_json)
    expect(out).toMatchObject({ ok: true, signing_algo: 'ecdsa', signature_kind: 'provider_tee', signing_address: standinAddress(KEY) })
    const req = utf8(sim().buildRequest(STANDIN_MODEL, 'a skeleton who is late for work'))
    const v = verifySigned(STANDIN_MODEL, req, utf8(out.response), out)
    expect(v.verified).toBe(true)
    expect(sim().normalize(JSON.parse(out.response).choices[0].message.content).ok).toBe(true)
  })
  it('a cached sentence (need_compile=false) still sends only {ok:true}', async () => {
    const w = world({ belts: [], forgeMode: 'relayer', nextChallenge: 1, challenges: { 0: forging({ need_compile: false }) } })
    const { d, calls } = setup(w, { relayer: true, fetchFn: offline })
    Object.assign(d.env, { COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: KEY })
    await run(d)
    expect(JSON.parse(calls.find((c) => c.method === 'submit_forge')!.args.output_json)).toEqual({ ok: true })
  })
})

describe('the opener (Vance) in stand-in mode', () => {
  it('opens a season with an exact roster sentence and never calls a model', async () => {
    const w = world({ autoMine: true, belts: [belt({ season: season({ state: 'Closed', final_holder: 'otto-ink.testnet', closes_at: ns(NOW_MS - 120_000) }) })] })
    const { d, calls } = setup(w, { fetchFn: offline })
    Object.assign(d.env, { COMPILER_MODE: 'standin', STANDIN_SIGNER_KEY: KEY })
    await run(d)
    const open = calls.find((c) => c.method === 'open_season')
    expect(open).toBeDefined()
    expect(STANDIN_OPENERS).toContain(open!.args.opener_sentence)
  })
})
