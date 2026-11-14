import { useEffect, useState } from 'react'

export type CompilerMode = 'nearai' | 'standin' | 'mock' | 'unknown'

let cached: Promise<CompilerMode> | null = null

/** Which compiler the deployment runs: read once from /api/state (falls back to 'unknown'). */
export function fetchCompilerMode(clientMode: 'mock' | 'testnet'): Promise<CompilerMode> {
  if (clientMode === 'mock') return Promise.resolve('mock')
  if (!cached) {
    cached = fetch('/api/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { compiler?: string } | null) => (j?.compiler === 'standin' ? 'standin' : j?.compiler === 'nearai' ? 'nearai' : 'unknown'))
      .catch(() => 'unknown' as const)
  }
  return cached
}

export function useCompilerMode(clientMode: 'mock' | 'testnet'): CompilerMode {
  const [m, setM] = useState<CompilerMode>(clientMode === 'mock' ? 'mock' : 'unknown')
  useEffect(() => { let live = true; void fetchCompilerMode(clientMode).then((x) => { if (live) setM(x) }); return () => { live = false } }, [clientMode])
  return m
}
