import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkArgs, contractAbi, parseAbi } from './contract-abi'
import { ROOT } from './helpers'

const abi = contractAbi()

describe('contract ABI table (parsed from contract/src)', () => {
  it('knows the methods and argument names the worker depends on', () => {
    expect(abi.get('expire_challenge')).toEqual(['id'])
    expect(abi.get('set_purse_address')).toEqual(['belt', 'season', 'addr'])
    expect(abi.get('get_payouts')).toEqual(['belt', 'season'])
    expect(abi.get('reset_payout_signing')).toEqual(['id'])
    expect(abi.get('sign_payout')).toEqual(['payout_id', 'max_fee_per_gas', 'max_priority_fee_per_gas', 'gas_limit'])
    expect(abi.get('close_season')).toEqual(['belt_id'])
    expect(abi.get('submit_forge')).toEqual(['challenge_id', 'output_json'])
  })
  it('parses multi-line signatures, callback attributes and skips associated functions', () => {
    const t = parseAbi('pub fn a(&mut self, x: u32, #[callback_result] r: Result<(), PromiseError>) {}\n pub fn new(owner: AccountId) -> Self {}\n pub fn b(\n &self,\n y: Vec<String>,\n z: Option<U128>) {}')
    expect(t.get('a')).toEqual(['x', 'r'])
    expect(t.has('new')).toBe(false)
    expect(t.get('b')).toEqual(['y', 'z'])
  })
  it('checkArgs rejects wrong, extra and missing names', () => {
    expect(() => checkArgs('expire_challenge', { challenge_id: 1 })).toThrow(/unknown: challenge_id/)
    expect(() => checkArgs('get_payouts', { belt_id: 1, season_id: 1 })).toThrow(/bad args/)
    expect(() => checkArgs('set_purse_address', { belt: 1, season: 2 })).toThrow(/missing: addr/)
    expect(() => checkArgs('expire_challenge', { id: 1 })).not.toThrow()
    expect(() => checkArgs('derived_public_key', { anything: 1 })).not.toThrow()
  })
})

// ---- every call site in the worker and the browser client, scanned from source
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
}
function keysOf(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  const flush = () => { const k = /^\s*([A-Za-z_]\w*)/.exec(cur); if (k) out.push(k[1]!); cur = '' }
  for (const ch of body) {
    if ('({['.includes(ch)) depth++
    else if (')}]'.includes(ch)) depth--
    if (ch === ',' && depth === 0) flush(); else cur += ch
  }
  flush()
  return out
}
// .call(recv, 'method', { ... })   fn('method', { ... })   view<T>('method', { ... })   rpc.view(recv, 'method', { ... })
const SITES = [
  /\.call\(\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*'(\w+)'\s*,\s*\{([^}]*)\}/g,
  /\bfn\(\s*'(\w+)'\s*,\s*\{([^}]*)\}/g,
  /\bview<[^>]*>\(\s*'(\w+)'\s*,\s*\{([^}]*)\}/g,
  /\.view(?:<[^>]*>)?\(\s*[^,()]+,\s*'(\w+)'\s*,\s*\{([^}]*)\}/g,
]

describe('every contract call in the source uses the contract argument names', () => {
  const found: { file: string; method: string; keys: string[] }[] = []
  for (const dir of ['functions', 'src/game']) {
    for (const f of files(join(ROOT, 'web', dir))) {
      const src = readFileSync(f, 'utf8')
      for (const re of SITES) for (let m = re.exec(src); m; m = re.exec(src)) found.push({ file: f.slice(ROOT.length + 1), method: m[1]!, keys: keysOf(m[2]!) })
    }
  }
  it('found the call sites it is meant to check', () => {
    const seen = new Set(found.map((x) => x.method))
    for (const m of ['close_season', 'expire_challenge', 'set_purse_address', 'open_season', 'sign_payout', 'submit_forge', 'deposit_for', 'challenge', 'get_payouts', 'get_fights', 'get_season']) expect(seen.has(m), m).toBe(true)
  })
  for (const s of found) {
    if (!abi.has(s.method)) continue
    it(`${s.file}: ${s.method}(${s.keys.join(', ')})`, () => {
      expect(() => checkArgs(s.method, Object.fromEntries(s.keys.map((k) => [k, 0])))).not.toThrow()
    })
  }
})
