// One entry point for "compile this sentence": the stand-in referee in staging mode, NEAR AI otherwise.
import type { Sim } from '../../src/sim'
import type { Env } from './env'
import { compile, type Compiled } from './nearai'
import { isStandin, standinCompile } from './standin'

export async function compileFor(env: Env, sim: Sim, model: string, sentence: string, fetchFn: typeof fetch = fetch): Promise<Compiled> {
  return isStandin(env) ? standinCompile(env, sim, model, sentence) : compile(env, sim, model, sentence, fetchFn)
}
