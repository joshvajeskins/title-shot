// Ownership proof for a NEAR account whose id is an Ethereum address (NEP-518, NEAR Connect's "Ethereum Wallets"). That
// wallet cannot sign NEP-413 messages, so the same EVM key signs the server's nonce with EIP-191 personal_sign, found
// through EIP-6963 in this page (MetaMask and other injected wallets).
import { GameError } from '../client'
import { toHex, utf8 } from '../chain/bytes'
import { discoverWallets, type WalletHost } from '../evm/discover'
import { errorCode, USER_REJECTED, type Eip1193Provider } from '../evm/types'

export const isEvmAccount = (id: string): boolean => /^0x[0-9a-f]{40}$/.test(id)

const accountsOf = async (p: Eip1193Provider, method: 'eth_accounts' | 'eth_requestAccounts'): Promise<string[]> => {
  try {
    const a = await p.request({ method })
    return Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : []
  } catch (e) {
    if (errorCode(e) === USER_REJECTED) throw new GameError('E_WALLET_REJECTED', 'You declined the connection in your Ethereum wallet. Nothing was moved.')
    return []
  }
}

/** The injected EVM wallet in this browser that holds `address`: one already connected first, else ask each once. */
export async function evmProviderFor(address: string, host: WalletHost = window as unknown as WalletHost): Promise<Eip1193Provider> {
  const wallets = await discoverWallets(host, 500)
  for (const w of wallets) if ((await accountsOf(w.provider, 'eth_accounts')).includes(address)) return w.provider
  for (const w of wallets) if ((await accountsOf(w.provider, 'eth_requestAccounts')).includes(address)) return w.provider
  throw new GameError('E_NO_EVM', wallets.length
    ? `None of this browser's Ethereum wallets holds ${address}. Switch to that account in your wallet (for example MetaMask) and try again.`
    : `Open this page in the browser where the wallet for ${address} is installed (for example MetaMask). A phone wallet linked by WalletConnect cannot sign this check here.`)
}

/** EIP-191 personal_sign of `message` by `address`. */
export async function personalSign(p: Eip1193Provider, address: string, message: string): Promise<string> {
  try {
    const sig = await p.request({ method: 'personal_sign', params: ['0x' + toHex(utf8(message)), address] })
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('the wallet returned no signature')
    return sig
  } catch (e) {
    if (errorCode(e) === USER_REJECTED) throw new GameError('E_WALLET_REJECTED', 'You declined the message in your Ethereum wallet. Nothing was moved.')
    throw new GameError('E_WALLET', `Your Ethereum wallet could not sign the message: ${e instanceof Error ? e.message : String(e)}`)
  }
}
