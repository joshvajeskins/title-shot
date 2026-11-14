// What the payout dialog says at each step and failure of the wallet flow (pure, so the words are tested with the logic).
import { chainName } from './chain'
import type { LinkStep } from './link'
import type { WalletError } from './types'

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'another account')

export function stepCopy(step: LinkStep, wallet: string): string {
  switch (step) {
    case 'connecting': return `Approve the connection in ${wallet}.`
    case 'switching': return `Switch ${wallet} to Base Sepolia.`
    case 'signing': return `Sign the message in ${wallet}. It is free and sends no transaction.`
    case 'verifying': return 'Checking the signature…'
  }
}

export interface ErrorCopy { title: string; body: string; retry: string; hint?: string }

export function errorCopy(e: WalletError, wallet: string): ErrorCopy {
  const chain = chainName(e.detail.chainId)
  switch (e.kind) {
    case 'rejected': return { title: 'Connection declined', body: `You said no in ${wallet}. Nothing was shared with this page.`, retry: 'Try again' }
    case 'sign-rejected': return { title: 'Signature declined', body: 'Without the signature there is no proof the address is yours, so nothing was saved. Signing is free and sends no transaction.', retry: 'Sign again' }
    case 'chain-refused': return { title: `Still on ${chain}`, body: `${wallet} stayed on ${chain}. Purse payouts are paid on Base Sepolia (chain 84532), so the wallet links from there.`, retry: 'Switch to Base Sepolia', hint: 'Your address is the same on every EVM network, so you can also paste it.' }
    case 'wrong-chain': return { title: 'Wrong network', body: `${wallet} is on ${chain} and could not switch from this page. Switch it to Base Sepolia (chain 84532) in the wallet, then try again.`, retry: 'Try again', hint: 'Your address is the same on every EVM network, so you can also paste it.' }
    case 'account-changed': return { title: 'Account changed', body: `${wallet} moved from ${short(e.detail.from)} to ${short(e.detail.to)} mid-way. Start again so the signature comes from the account you will be paid at.`, retry: e.detail.to ? `Link ${short(e.detail.to)}` : 'Start again' }
    case 'no-account': return { title: 'No account shared', body: `${wallet} connected without sharing an account. Unlock it, or create an account in it, then try again.`, retry: 'Try again' }
    case 'pending': return { title: 'Request already open', body: `${wallet} is already showing a request. Open the wallet, finish or dismiss it, then try again.`, retry: 'Try again' }
    case 'bad-signature': return { title: "Signature didn't match", body: `The signature did not come from the account ${wallet} shared. Smart-contract wallets cannot be checked here.`, retry: 'Try again', hint: 'If the address is yours, you can paste it instead.' }
    case 'cancelled': return { title: 'Cancelled', body: 'Nothing was saved.', retry: 'Start again' }
    case 'failed': return { title: 'Wallet error', body: e.message, retry: 'Try again' }
  }
}
