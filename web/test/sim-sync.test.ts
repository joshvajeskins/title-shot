import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { ROOT, sim } from './helpers'
import { toHex } from '../src/game/chain/bytes'

const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures/request-golden.json'), 'utf8'))

describe('the bout-sim wasm shipped with the web app is the one the Rust crate builds', () => {
  it('its rulebook hash equals the native Rust golden (run scripts/regen-golden.sh when this fails)', () => {
    expect(sim().rulebook().hash).toBe(golden.rulebook_hash)
  })
  it('the web copy is byte-identical to crates/bout-sim/pkg when that build exists', () => {
    const built = join(ROOT, 'crates/bout-sim/pkg/bout_sim_bg.wasm')
    if (!existsSync(built)) return
    const a = toHex(sha256(readFileSync(built)))
    const b = toHex(sha256(readFileSync(join(ROOT, 'web/src/sim/pkg/bout_sim_bg.wasm'))))
    expect(b, 'run scripts/sync-sim.sh').toBe(a)
  })
  it('the wasm exposes the full JSON API the client and workers rely on', () => {
    const s = sim()
    expect(Object.keys(s).sort()).toEqual(['buildRequest', 'checkSentence', 'normalize', 'odds', 'requestParts', 'rulebook', 'simulate'])
    expect(s.rulebook().library.length).toBeGreaterThan(30)
    expect(s.rulebook().rules.length).toBe(8)
  })
})
