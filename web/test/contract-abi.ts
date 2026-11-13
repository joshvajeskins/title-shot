// The contract's JSON-argument table, parsed from contract/src/*.rs. Fakes and the call-site scan use it so a wrong
// argument name (which near-sdk rejects as a missing field) fails a test instead of the live game.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = join(__dirname, '..', '..')

export type Abi = Map<string, string[]>

function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if ('(<[{'.includes(ch)) depth++
    else if (')>]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

/** `pub fn name(&self | &mut self, a: T, ...)` -> name -> [a, ...]. Associated functions without `self` are skipped. */
export function parseAbi(src: string): Abi {
  const abi: Abi = new Map()
  const re = /pub fn (\w+)\s*\(/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = re.lastIndex
    let depth = 1
    const start = i
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth-- }
    const params = splitTop(src.slice(start, i - 1))
    if (!params.length || !/^&(mut )?self$/.test(params[0]!)) continue
    abi.set(m[1]!, params.slice(1).map((p) => p.replace(/^#\[[^\]]*\]\s*/, '').split(':')[0]!.trim().replace(/^mut /, '')))
  }
  return abi
}

let cached: Abi | null = null
export function contractAbi(): Abi {
  if (cached) return cached
  const dir = join(ROOT, 'contract', 'src')
  const abi: Abi = new Map()
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.rs'))) for (const [k, v] of parseAbi(readFileSync(join(dir, f), 'utf8'))) abi.set(k, v)
  cached = abi
  return abi
}

/** Throws when `args` has a key the method does not take, or lacks one it requires. */
export function checkArgs(method: string, args: unknown, abi = contractAbi()): void {
  const want = abi.get(method)
  if (!want) return // not a contract method (RPC helper, MPC signer)
  const got = args && typeof args === 'object' ? Object.keys(args as object) : []
  const extra = got.filter((k) => !want.includes(k))
  const missing = want.filter((k) => !got.includes(k))
  if (extra.length || missing.length) throw new Error(`${method}: bad args (unknown: ${extra.join(',') || '-'}; missing: ${missing.join(',') || '-'}); the contract takes (${want.join(', ')})`)
}
