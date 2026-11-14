import { useEffect, useState } from 'react'

export type CompilerMode = 'nearai' | 'standin' | 'mock' | 'unknown'
export interface ForgeStatus { open: boolean; reason?: string; resetsAt?: number; spentUsd?: number; budgetUsd?: number }
export interface DeployInfo { compiler: CompilerMode; forge: ForgeStatus; portraitsOpen: boolean }

const OPEN: DeployInfo = { compiler: 'unknown', forge: { open: true }, portraitsOpen: true }
let cached: { at: number; p: Promise<DeployInfo> } | null = null

/** Deployment facts from /api/state (compiler, forge budget, portrait budget). Cached for 20 s. */
export function fetchDeployInfo(clientMode: 'mock' | 'testnet', fresh = false): Promise<DeployInfo> {
  if (clientMode === 'mock') return Promise.resolve({ compiler: 'mock', forge: { open: true }, portraitsOpen: true })
  if (!fresh && cached && Date.now() - cached.at < 20_000) return cached.p
  const p = fetch('/api/state')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { compiler?: string; forge?: ForgeStatus; portraits?: { open?: boolean } } | null): DeployInfo => ({
      compiler: j?.compiler === 'standin' ? 'standin' : j?.compiler === 'nearai' ? 'nearai' : 'unknown',
      forge: j?.forge && typeof j.forge.open === 'boolean' ? j.forge : { open: true },
      portraitsOpen: j?.portraits?.open !== false,
    }))
    .catch(() => OPEN)
  cached = { at: Date.now(), p }
  return p
}

export function fetchCompilerMode(clientMode: 'mock' | 'testnet'): Promise<CompilerMode> {
  return fetchDeployInfo(clientMode).then((d) => d.compiler)
}

export function useDeployInfo(clientMode: 'mock' | 'testnet'): DeployInfo {
  const [d, setD] = useState<DeployInfo>(clientMode === 'mock' ? { compiler: 'mock', forge: { open: true }, portraitsOpen: true } : OPEN)
  useEffect(() => { let live = true; void fetchDeployInfo(clientMode).then((x) => { if (live) setD(x) }); return () => { live = false } }, [clientMode])
  return d
}

export function useCompilerMode(clientMode: 'mock' | 'testnet'): CompilerMode {
  return useDeployInfo(clientMode).compiler
}
