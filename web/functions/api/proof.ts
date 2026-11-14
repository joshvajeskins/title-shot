// GET /api/proof: the contract-level facts behind the "Tale of the tape" page, read live from NEAR testnet.
// Deployed code hash, AI signer allowlist, forge mode (and any staged change), request bytes vs this site's rulebook,
// deploy gates, solvency and compile caps. Cached 15 s; everything here is public chain state.
import { Chain, rpcFor } from '../_lib/chain'
import { cachedJson, scoped } from '../_lib/cache'
import { ApiError, handle, json, methodGuard } from '../_lib/http'
import { enforce, RULES } from '../_lib/ratelimit'
import { sim } from '../_lib/sim'
import { requestMatches } from '../_lib/state'
import type { ContractConfig } from '../_lib/chain'
import { b58decode } from '../../src/game/chain/base58'

interface Gates { ok: boolean; ready: boolean; failing: { gate: string; why: string; blocking: boolean }[] }
interface Solvency { balance: string; storage_cost: string; owed: string; endowment: string; deficit: string; players_covered: boolean }
interface Caps { daily: number; total: number; today: number; used: number; open: boolean }
type Cfg = ContractConfig & {
  owner: string; signature_kind: string; forge_mode: string; relayers: string[]; vrf_pubkey: string | null
  allowlist_delay_sec: number; mpc_signer: string; forge_project: string
  pending_config: { request: unknown; forge_mode: string | null; activates_at: string } | null
}

export interface ProofResponse {
  at: number; contract: string; codeHash: { hex: string; b58: string } | null
  model: string; signatureKind: string; forgeMode: string; forgeProject: string; mpcSigner: string; owner: string
  pending: { forgeMode: string | null; requestChange: boolean; activatesAt: number } | null
  allowlist: string[]; allowlistDelaySec: number; relayers: string[]; vrfPinned: boolean
  request: { prefixSha256: string; suffixSha256: string; matchesSite: boolean }
  gates: Gates; solvency: Solvency; caps: Caps
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

async function codeHash(env: Parameters<typeof rpcFor>[0], contract: string): Promise<ProofResponse['codeHash']> {
  try {
    const r = await rpcFor(env).call<{ code_hash: string }>('query', { request_type: 'view_account', finality: 'final', account_id: contract })
    return { b58: r.code_hash, hex: toHex(b58decode(r.code_hash)) }
  } catch { return null }
}

async function build(env: Parameters<typeof rpcFor>[0], contract: string): Promise<ProofResponse> {
  const chain = new Chain(env)
  const [cfg, allowlist, gates, solvency, caps, code] = await Promise.all([
    chain.view<Cfg>('get_config'), chain.view<string[]>('get_allowlist'), chain.view<Gates>('get_deploy_gates'),
    chain.view<Solvency>('get_solvency'), chain.view<Caps>('get_compile_caps'), codeHash(env, contract),
  ])
  const p = cfg.pending_config
  return {
    at: Date.now(), contract, codeHash: code,
    model: cfg.model_id, signatureKind: cfg.signature_kind, forgeMode: cfg.forge_mode, forgeProject: cfg.forge_project,
    mpcSigner: cfg.mpc_signer, owner: cfg.owner,
    pending: p ? { forgeMode: p.forge_mode, requestChange: p.request != null, activatesAt: Math.floor(Number(BigInt(p.activates_at) / 1_000_000n)) } : null,
    allowlist, allowlistDelaySec: cfg.allowlist_delay_sec, relayers: cfg.relayers, vrfPinned: !!cfg.vrf_pubkey,
    request: { prefixSha256: cfg.prefix_sha256, suffixSha256: cfg.suffix_sha256, matchesSite: requestMatches(sim(), cfg) },
    gates, solvency: { balance: solvency.balance, storage_cost: solvency.storage_cost, owed: solvency.owed, endowment: solvency.endowment, deficit: solvency.deficit, players_covered: solvency.players_covered },
    caps: { daily: caps.daily, total: caps.total, today: caps.today, used: caps.used, open: caps.open },
  }
}

export const onRequest = handle(async ({ request, env }) => {
  methodGuard(request, ['GET'])
  await enforce(env.TS_KV, RULES.stateMin, request, undefined, 'open')
  const contract = (env.CONTRACT_ID ?? '').trim()
  if (!contract) throw new ApiError(503, 'NOT_DEPLOYED', 'The game is not live yet.')
  const data = await cachedJson(env.TS_KV, scoped(contract, 'proof:v1'), 15, () => build(env, contract), 30)
  return json(data, 200, { 'cache-control': 'public, max-age=10' })
})
