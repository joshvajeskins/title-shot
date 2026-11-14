// Put the wallet on Base Sepolia: switch, add the chain when the wallet does not know it, and check that it took.
import { chainIdOf, errorCode, REQUEST_PENDING, UNRECOGNIZED_CHAIN, UNSUPPORTED_METHOD, USER_REJECTED, WalletError, type Eip1193Provider } from './types'

export const BASE_SEPOLIA_ID = 84532
export const BASE_SEPOLIA_HEX = '0x14a34'
export const BASE_SEPOLIA = {
  chainId: BASE_SEPOLIA_HEX,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
} as const

const NAMES: Record<number, string> = {
  1: 'Ethereum', 8453: 'Base', 84532: 'Base Sepolia', 11155111: 'Sepolia', 10: 'OP Mainnet', 42161: 'Arbitrum One',
  137: 'Polygon', 56: 'BNB Chain', 43114: 'Avalanche', 59144: 'Linea', 324: 'zkSync Era', 17000: 'Holesky',
}
/** A chain's everyday name, or "chain 1234". */
export const chainName = (id: number | undefined): string => (id === undefined ? 'another network' : NAMES[id] ?? `chain ${id}`)

/** MetaMask mobile and some others report an unknown chain as -32603 with a message instead of 4902. */
const unknownChain = (e: unknown): boolean => errorCode(e) === UNRECOGNIZED_CHAIN || /unrecognized chain|chain .*not (been )?added|unknown chain/i.test(String((e as Error)?.message ?? ''))

export async function currentChain(p: Eip1193Provider): Promise<number | undefined> {
  return chainIdOf(await p.request({ method: 'eth_chainId' }))
}

const refused = (from: number | undefined) => new WalletError('chain-refused', `You kept the wallet on ${chainName(from)}.`, { chainId: from })

async function switchTo(p: Eip1193Provider, from: number | undefined): Promise<void> {
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_HEX }] })
  } catch (e) {
    if (errorCode(e) === USER_REJECTED) throw refused(from)
    if (errorCode(e) === REQUEST_PENDING) throw new WalletError('pending', 'The wallet already has a request open.')
    throw e
  }
}

/**
 * Make sure the wallet is on Base Sepolia. Returns true when it had to switch. Throws WalletError `chain-refused` when the
 * user declines the switch or the add, `wrong-chain` when the wallet cannot switch or ends up elsewhere.
 */
export async function ensureBaseSepolia(p: Eip1193Provider): Promise<boolean> {
  const from = await currentChain(p)
  if (from === BASE_SEPOLIA_ID) return false
  try {
    await switchTo(p, from)
  } catch (e) {
    if (e instanceof WalletError) throw e
    if (errorCode(e) === UNSUPPORTED_METHOD) throw new WalletError('wrong-chain', 'This wallet cannot switch networks from a page.', { chainId: from })
    if (!unknownChain(e)) throw new WalletError('wrong-chain', 'The wallet could not switch to Base Sepolia.', { chainId: from })
    try {
      await p.request({ method: 'wallet_addEthereumChain', params: [BASE_SEPOLIA] })
    } catch (e2) {
      if (errorCode(e2) === USER_REJECTED) throw refused(from)
      throw new WalletError('wrong-chain', 'The wallet could not add Base Sepolia.', { chainId: from })
    }
    // most wallets switch as they add; the rest need asking again
    if ((await currentChain(p)) !== BASE_SEPOLIA_ID) await switchTo(p, from)
  }
  const now = await currentChain(p)
  if (now !== BASE_SEPOLIA_ID) throw new WalletError('wrong-chain', `The wallet is still on ${chainName(now)}.`, { chainId: now })
  return true
}
