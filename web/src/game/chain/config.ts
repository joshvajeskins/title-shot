// Chain constants shared by the browser client and the Pages Functions.
export const NS_PER_MS = 1_000_000n
export const BASESCAN = 'https://sepolia.basescan.org'
export const NEARBLOCKS = 'https://testnet.nearblocks.io'
export const txUrl = (hash: string) => `${NEARBLOCKS}/txns/${hash}`
export const baseTxUrl = (hash: string) => `${BASESCAN}/tx/${hash}`
export const baseAddrUrl = (addr: string) => `${BASESCAN}/address/${addr}`

export const GAS_CHALLENGE = 300_000_000_000_000n // 300 Tgas, the per-tx maximum: OutLayer mode (request 150 + callback 60 + margin)
/** Relayer mode: `challenge` only records the pending forge (~4.4 Tgas burnt; sandbox worst case 20 Tgas). Testnet needs the
 *  prepaid gas times the gas price as headroom in the signer's balance and key allowance, so a guest holding 0.1 NEAR for gas
 *  cannot attach 300 Tgas: that transaction is dropped without an error. */
export const GAS_CHALLENGE_RELAYER = 50_000_000_000_000n
export const challengeGas = (forgeMode?: string): bigint => (forgeMode === 'outlayer' ? GAS_CHALLENGE : GAS_CHALLENGE_RELAYER)
/** Guest economics defaults; the Pages vars GUEST_GAS_NEAR / GUEST_DEPOSIT_NEAR override them (functions/_lib/guest.ts). */
export const GUEST_FUND_GAS = 100_000_000_000_000_000_000_000n // 0.1 NEAR for gas
export const GUEST_DEPOSIT = 300_000_000_000_000_000_000_000n // 0.3 NEAR into the contract balance

/** Fee and gas bounds enforced by the contract (`economy::gas_params_ok`). */
export const GAS_LIMIT_MIN = 21_000n
export const GAS_LIMIT_MAX = 150_000n
export const MAX_FEE_CAP_WEI = 50_000_000_000n // 50 gwei
