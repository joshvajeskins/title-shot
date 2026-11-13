import rb from './rulebook.json'
import type { School } from './types'

export interface LibMove { index: number; id: string; name: string; school: School; kind: 'strike' | 'hex' | 'guard' | 'boost'; desc: string }
const LIB = (rb as { library: LibMove[] }).library
const BY_ID = new Map(LIB.map((m) => [m.id, m]))

export const RULEBOOK_HASH: string = (rb as { hash: string }).hash
export function moveByIndex(i: number): LibMove | null { return LIB[i] ?? null }
export function moveById(id: string): LibMove | null { return BY_ID.get(id) ?? null }
export function moveInfo(id: string): { name: string; desc: string } | null { const m = BY_ID.get(id); return m ? { name: m.name, desc: m.desc } : null }
