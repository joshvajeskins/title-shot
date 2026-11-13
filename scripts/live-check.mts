// Live testnet check of the promoter's chain plumbing (no contract needed): derives Vance's Base Sepolia address from the
// MPC signer, reads Base fee data, has Vance sign a real EIP-1559 transfer digest through v1.signer-prod.testnet and checks
// the signature recovers to the derived address. Costs about 0.002 NEAR of Vance's gas. Nothing is broadcast.
//   cd web && pnpm exec tsx ../scripts/live-check.mts
import { Rpc } from '../web/src/game/chain/rpc'
import { Signer } from '../web/src/game/chain/signer'
import { BASE_CHAIN_ID, deriveEvmAddress, getBalance, getFeeHistory, getNonce } from '../web/functions/_lib/evm'
import { feeParams } from '../web/functions/_lib/fees'
import { mpcSign, recoverSigner, signedRaw, txDigest, VANCE_PATH, type Eip1559Tx } from '../web/functions/_lib/purse'
import { DEFAULTS } from '../web/functions/_lib/env'
import { loadCred } from './lib'

const near = new Rpc()
const base = new Rpc({ urls: DEFAULTS.baseRpcs })
const MPC = DEFAULTS.mpcSigner
const vanceId = DEFAULTS.vanceId

const addr = await deriveEvmAddress(near, MPC, VANCE_PATH, vanceId)
console.log('Vance Base Sepolia address:', addr)
console.log('balance (wei):', (await getBalance(base, addr)).toString(), ' nonce:', (await getNonce(base, addr)).toString())
const fees = feeParams(await getFeeHistory(base))
console.log('fees (wei):', { maxFee: fees.maxFee.toString(), priority: fees.priority.toString() })

const cred = loadCred(vanceId)
if (!cred) throw new Error('no credentials for vance')
const vance = new Signer(vanceId, cred.key, near)
const tx: Eip1559Tx = { type: 'eip1559', chainId: BASE_CHAIN_ID, nonce: 0, to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n, maxFeePerGas: fees.maxFee, maxPriorityFeePerGas: fees.priority }
const digest = txDigest(tx)
const t0 = Date.now()
const sig = await mpcSign(vance, MPC, VANCE_PATH, digest)
const raw = signedRaw(tx, sig)
const recovered = await recoverSigner(raw)
console.log(`MPC signature in ${Date.now() - t0} ms, recovers to ${recovered}`, recovered.toLowerCase() === addr.toLowerCase() ? 'MATCH' : 'MISMATCH')
if (recovered.toLowerCase() !== addr.toLowerCase()) process.exit(1)
