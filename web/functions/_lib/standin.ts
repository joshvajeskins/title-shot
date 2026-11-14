// The staging stand-in compiler: same envelope the contract parses (OpenAI-style chat completion, provider_tee text, EIP-191
// secp256k1 signature), signed with STANDIN_SIGNER_KEY instead of NEAR AI's TEE key. Only used when NEARAI_API_KEY is absent
// AND COMPILER_MODE=standin; the contract it feeds must list `standinAddress` as its only signer (staging.titleshot.testnet).
import { toHex, utf8 } from '../../src/game/chain/bytes'
import { expectedText, sha256Hex, verifySigned } from '../../src/game/chain/signature'
import type { Sim } from '../../src/sim'
import type { Env } from './env'
import type { Compiled } from './nearai'
import { secretKey, signText, standinAddress } from './standinKey'
import { standinRaw } from './standinSpec'

export { standinAddress }

export const STANDIN_MODEL = 'standin/compiler-v1'

type ModeEnv = Pick<Env, 'NEARAI_API_KEY' | 'COMPILER_MODE'>
/** Stand-in mode: no NEAR AI key and COMPILER_MODE=standin. A real key always wins. */
export const isStandin = (env: ModeEnv): boolean => !env.NEARAI_API_KEY && env.COMPILER_MODE === 'standin'
export const compilerOf = (env: ModeEnv): 'nearai' | 'standin' => (isStandin(env) ? 'standin' : 'nearai')

/** The response bytes a chat completion for `req` would have, carrying `content`. Deterministic. */
export function envelope(model: string, req: Uint8Array, content: string): string {
  return JSON.stringify({
    id: `chatcmpl-standin-${sha256Hex(req).slice(0, 16)}`, object: 'chat.completion', model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

/** Compile `sentence` with the stand-in referee. Same shape as the NEAR AI `compile`, so callers do not care which one ran. */
export function standinCompile(env: Env, sim: Sim, model: string, sentence: string): Compiled {
  const sk = secretKey(env.STANDIN_SIGNER_KEY)
  const req = utf8(sim.buildRequest(model, sentence))
  const raw = JSON.stringify(standinRaw(sim, sentence))
  const response = envelope(model, req, raw)
  const resp = utf8(response)
  const text = expectedText('provider_tee', model, req, resp)!
  const signed = { text, signature: signText(sk, text), signing_address: standinAddress(toHex(sk)), signing_algo: 'ecdsa', signature_kind: 'provider_tee' }
  return { raw, response, signed, verification: verifySigned(model, req, resp, signed), model }
}
