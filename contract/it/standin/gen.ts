// Generates contract/it/standin/vectors.json with the web's own staging stand-in compiler (web/functions/_lib/standin.ts):
// the exact submit_forge output the relayer tick sends (tick.ts `relay`), signed with a fixed TEST scalar that is not used
// on any network. Run from web/:  npx tsx ../contract/it/standin/gen.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadSimSync } from '../../../web/src/sim'
import { STANDIN_MODEL, standinAddress, standinCompile } from '../../../web/functions/_lib/standin'
import { cleanSentence } from '../../../web/src/game/sentence'

const here = dirname(fileURLToPath(import.meta.url))
const sim = loadSimSync(readFileSync(join(here, '../../../web/src/sim/pkg/bout_sim_bg.wasm')))
// Throwaway test scalar (any valid secp256k1 scalar works); the sandbox contract allowlists its address.
const TEST_SCALAR = '11'.repeat(32)
const env = { STANDIN_SIGNER_KEY: TEST_SCALAR, COMPILER_MODE: 'standin' } as never
const sentences = [
  'a very polite kraken',
  'a "quoted" cat\\with a backslash, an émoji 🥊 and ünïcödé',
  'the toaster that remembers   every   slice',
]
const vectors = sentences.map((s) => {
  const sentence = cleanSentence(s)
  const c = standinCompile(env, sim, STANDIN_MODEL, sentence)
  // Exactly what web/functions/_lib/tick.ts `relay` sends as output_json.
  const output = { ok: true, response: c.response, signature: c.signed.signature, signing_address: c.signed.signing_address,
    signing_algo: c.signed.signing_algo, signature_kind: c.signed.signature_kind, text: c.signed.text }
  return { sentence, verified_by_web: c.verification, request: sim.buildRequest(STANDIN_MODEL, sentence), output_json: JSON.stringify(output) }
})
writeFileSync(join(here, 'vectors.json'), JSON.stringify({ model: STANDIN_MODEL, signer: standinAddress(TEST_SCALAR), vectors }, null, 1) + '\n')
console.error(`wrote ${vectors.length} vectors, signer ${standinAddress(TEST_SCALAR)}`)
