// Find the fields a fighter's portrait and cry need: on chain first, else the preview cache (an unforged sentence).
import { getJson } from './cache'
import type { Chain } from './chain'
import type { KVLike } from './env'

export interface FighterLook { look: string; cry: string; school: string; style: string; name: string }

export const previewKey = (hash: string) => `preview:${hash}`
/** "No such fighter" is remembered for MISS_TTL_SEC so a scan of unknown hashes costs one chain read each per minute. */
export const missKey = (kind: 'portrait' | 'cry', hash: string) => `miss:${kind}:${hash}`
export const MISS_TTL_SEC = 60

/** `status.chainError` is set when the chain could not be asked, so a miss is not proof the fighter does not exist. */
export async function lookupFighter(kv: KVLike, chain: Chain | null, hash: string, status?: { chainError: boolean }): Promise<FighterLook | null> {
  if (chain) {
    const f = await chain.fighter(hash).catch(() => { if (status) status.chainError = true; return null })
    if (f) return { look: f.spec.look, cry: f.spec.cry, school: f.spec.school, style: f.spec.style, name: f.spec.name }
  }
  const p = await getJson<{ fighter: FighterLook }>(kv, previewKey(hash))
  return p?.fighter ?? null
}
