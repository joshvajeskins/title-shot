// The message a wallet signs to link its address to a NEAR account, and the check that the signature came from that
// address. Signing is free (personal_sign, no transaction); it proves the player controls the EOA before anything is saved.
import { getAddress, isAddress, toHex, verifyMessage, type Hex } from 'viem'
import { BASE_SEPOLIA_ID } from './chain'

export interface Binding {
  nearAccount: string
  /** any casing; the message carries the EIP-55 checksum form */
  address: string
  /** the site asking (location.host) */
  domain: string
  nonce: string
  /** ISO-8601 time the message was made */
  issuedAt: string
  chainId?: number
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
const NONCE = /^[0-9a-f]{16,64}$/

/** 16 random bytes as hex, from the browser's CSPRNG. */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** The readable message, one fact per line. Throws on input that should never reach a wallet. */
export function bindingMessage(b: Binding): string {
  if (!NEAR_ACCOUNT.test(b.nearAccount)) throw new Error('Not a NEAR account id.')
  if (!isAddress(b.address, { strict: false })) throw new Error('Not an EVM address.')
  if (!NONCE.test(b.nonce)) throw new Error('The nonce must be 16 to 64 lowercase hex characters.')
  if (!b.domain || /\s/.test(b.domain)) throw new Error('The domain must be a host name.')
  const chain = b.chainId ?? BASE_SEPOLIA_ID
  return [
    `${b.domain} asks you to link this wallet to a Title Shot corner.`,
    '',
    `Purse payouts for ${b.nearAccount} will be sent to ${getAddress(b.address)} on Base Sepolia.`,
    '',
    `NEAR account: ${b.nearAccount}`,
    `EVM address: ${getAddress(b.address)}`,
    `Chain ID: ${chain}`,
    `Domain: ${b.domain}`,
    `Nonce: ${b.nonce}`,
    `Issued at: ${b.issuedAt}`,
    '',
    'Signing is free. It sends no transaction and moves no funds.',
  ].join('\n')
}

/** The personal_sign payload: the message as UTF-8 hex, then the address (the EIP-1193 order every wallet accepts). */
export function personalSignParams(message: string, address: string): [Hex, string] {
  return [toHex(message), address]
}

/** True when `signature` is `address`'s EIP-191 signature of exactly `message`. Malformed signatures are false, not errors. */
export async function verifyBinding(message: string, signature: string, address: string): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || !isAddress(address, { strict: false })) return false
  try { return await verifyMessage({ address: getAddress(address), message, signature: signature as Hex }) } catch { return false }
}
