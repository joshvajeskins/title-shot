// Guest account keys live in this browser only (`ts-account`). Never sent anywhere except as public keys to /api/guest.
import { formatPublicKey, formatSecretKey, generateKeyPair, parseSecretKey, type KeyPair } from './chain/keys'

export const ACCOUNT_KEY = 'ts-account'
const ARCHIVE_KEY = 'ts-account-archive'
/** Keys of a guest whose /api/guest request has not succeeded yet: kept so a retry resumes the same account (and its key is never lost). */
export const PENDING_KEY = 'ts-account-pending'

export interface StoredAccount {
  accountId: string
  /** full-access key: the player's recovery key (offered by "export key") */
  fullKey: string
  /** function-call key (receiver = the contract, method `challenge` only): signs every fight */
  sessionKey: string
  createdAt: number
}

export interface KeyStore { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }

/** localStorage when it works, memory otherwise (private windows, blocked storage). */
export function browserStore(): KeyStore {
  const mem = new Map<string, string>()
  return {
    get(k) { try { return localStorage.getItem(k) } catch { return mem.get(k) ?? null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch { mem.set(k, v) } },
    remove(k) { try { localStorage.removeItem(k) } catch { mem.delete(k) } },
  }
}

export interface NewKeys { full: KeyPair; session: KeyPair; fullPublic: string; sessionPublic: string }

export function newGuestKeys(): NewKeys {
  const full = generateKeyPair()
  const session = generateKeyPair()
  return { full, session, fullPublic: formatPublicKey(full.publicKey), sessionPublic: formatPublicKey(session.publicKey) }
}

const keysFrom = (full: KeyPair, session: KeyPair): NewKeys => ({ full, session, fullPublic: formatPublicKey(full.publicKey), sessionPublic: formatPublicKey(session.publicKey) })

/** The keys of an unfinished guest creation, or fresh ones (saved before the request is sent). */
export function pendingOrNewKeys(store: KeyStore): NewKeys {
  try {
    const p = JSON.parse(store.get(PENDING_KEY) ?? 'null') as { fullKey?: string; sessionKey?: string } | null
    if (p?.fullKey && p.sessionKey) return keysFrom(parseSecretKey(p.fullKey), parseSecretKey(p.sessionKey))
  } catch { /* unreadable: start over */ }
  const keys = newGuestKeys()
  store.set(PENDING_KEY, JSON.stringify({ fullKey: formatSecretKey(keys.full), sessionKey: formatSecretKey(keys.session), createdAt: Date.now() }))
  return keys
}

export function clearPending(store: KeyStore): void { store.remove(PENDING_KEY) }

export function isStoredAccount(x: unknown): x is StoredAccount {
  const o = x as StoredAccount
  return !!o && typeof o.accountId === 'string' && typeof o.fullKey === 'string' && typeof o.sessionKey === 'string' && o.fullKey.startsWith('ed25519:') && o.sessionKey.startsWith('ed25519:')
}

export function loadStored(store: KeyStore): StoredAccount | null {
  try {
    const raw = store.get(ACCOUNT_KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    return isStoredAccount(j) ? j : null
  } catch { return null }
}

export function saveStored(store: KeyStore, keys: NewKeys, accountId: string): StoredAccount {
  const a: StoredAccount = { accountId, fullKey: formatSecretKey(keys.full), sessionKey: formatSecretKey(keys.session), createdAt: Date.now() }
  store.set(ACCOUNT_KEY, JSON.stringify(a))
  return a
}

/**
 * Save a freshly created guest as the active account, but never over an account that is already stored (it may hold funds):
 * if one appeared while the request was in flight (another tab), the new keys go to the archive instead.
 * Returns the account that is active afterwards.
 */
export function saveStoredIfFree(store: KeyStore, keys: NewKeys, accountId: string): StoredAccount {
  const existing = loadStored(store)
  if (!existing) return saveStored(store, keys, accountId)
  archiveAccount(store, { accountId, fullKey: formatSecretKey(keys.full), sessionKey: formatSecretKey(keys.session), createdAt: Date.now() })
  return existing
}

/** Keep an account's keys without making it the active one (a guest created by a racing tab, or a failed save): never lost, always exportable. */
export function archiveAccount(store: KeyStore, a: StoredAccount): void {
  let list: StoredAccount[] = []
  try { list = JSON.parse(store.get(ARCHIVE_KEY) ?? '[]') as StoredAccount[] } catch { /* start fresh */ }
  store.set(ARCHIVE_KEY, JSON.stringify([...list.filter((x) => x.accountId !== a.accountId), a].slice(-5)))
}

/** Sign out without losing money: the account moves to an archive the player can still export from. */
export function archiveStored(store: KeyStore): void {
  const cur = loadStored(store)
  if (cur) archiveAccount(store, cur)
  store.remove(ACCOUNT_KEY)
}

/** The recovery payload for the "export key" menu item (the full-access key; guard it like a wallet). */
export function exportKey(store: KeyStore): { accountId: string; privateKey: string } | null {
  const a = loadStored(store)
  return a ? { accountId: a.accountId, privateKey: a.fullKey } : null
}
