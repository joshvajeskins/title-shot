import { describe, expect, it } from 'vitest'
import { bumpedFee, clampGas, feeParams, payoutValue } from '../functions/_lib/fees'
import { GAS_LIMIT_MAX, GAS_LIMIT_MIN, MAX_FEE_CAP_WEI } from '../src/game/chain/config'

describe('payout gas clamping (contract bounds 21000..150000)', () => {
  it('pads the estimate by 20%', () => expect(clampGas(21_000n)).toBe(25_200n))
  it('never goes below the contract minimum', () => expect(clampGas(1n)).toBe(GAS_LIMIT_MIN))
  it('never goes above the contract maximum', () => { expect(clampGas(10_000_000n)).toBe(GAS_LIMIT_MAX); expect(clampGas(125_000n)).toBe(GAS_LIMIT_MAX) })
  it('is monotonic and always inside the bounds', () => {
    let prev = 0n
    for (let e = 0n; e < 400_000n; e += 997n) {
      const g = clampGas(e)
      expect(g).toBeGreaterThanOrEqual(GAS_LIMIT_MIN); expect(g).toBeLessThanOrEqual(GAS_LIMIT_MAX); expect(g).toBeGreaterThanOrEqual(prev)
      prev = g
    }
  })
})

describe('fee parameters from eth_feeHistory (contract: 1 <= maxFee <= 50 gwei, priority <= maxFee)', () => {
  it('uses 3x the next base fee plus the median tip', () => {
    const f = feeParams({ baseFeePerGas: ['0x5f5e100', '0x5f5e100', '0x5f5e100', '0x5f5e100', '0x5f5e100', '0x7270e00'], reward: [['0x186a0'], ['0x2faf080'], ['0x2faf080'], ['0x0'], ['0x2faf080']] })
    expect(f.maxFee).toBe(120_000_000n * 3n + 50_000_000n)
    expect(f.priority).toBe(50_000_000n)
  })
  it('falls back to 0.001 gwei priority when tips are zero or missing', () => {
    expect(feeParams({ baseFeePerGas: ['0x1', '0x2'] }).priority).toBe(1_000_000n)
    expect(feeParams({ baseFeePerGas: ['0x1', '0x2'], reward: [['0x0'], ['0x0']] }).priority).toBe(1_000_000n)
  })
  it('clamps an absurd base fee to the 50 gwei cap', () => {
    const f = feeParams({ baseFeePerGas: ['0xffffffffffffff'] })
    expect(f.maxFee).toBe(MAX_FEE_CAP_WEI)
    expect(f.priority).toBeLessThanOrEqual(f.maxFee)
  })
  it('an empty history still yields valid parameters', () => {
    const f = feeParams({ baseFeePerGas: [] })
    expect(f.maxFee).toBeGreaterThanOrEqual(1n)
    expect(f.priority).toBeLessThanOrEqual(f.maxFee)
  })
  it('priority never exceeds maxFee and maxFee stays in bounds for random inputs', () => {
    for (let i = 0; i < 500; i++) {
      const base = BigInt(Math.floor(Math.random() * 1e12)), tip = BigInt(Math.floor(Math.random() * 1e12))
      const f = feeParams({ baseFeePerGas: ['0x1', '0x' + base.toString(16)], reward: [['0x' + tip.toString(16)]] })
      expect(f.priority).toBeLessThanOrEqual(f.maxFee); expect(f.maxFee).toBeLessThanOrEqual(MAX_FEE_CAP_WEI); expect(f.maxFee).toBeGreaterThanOrEqual(1n)
    }
  })
})

describe('payout value and re-sign bump', () => {
  it('the payee pays gas out of the payout', () => expect(payoutValue(1_000_000_000_000_000n, 25_200n, 1_000_000n)).toBe(1_000_000_000_000_000n - 25_200n * 1_000_000n))
  it('dust (amount <= gas cost) is refused like the contract E_DUST', () => { expect(payoutValue(25_200_000_000n, 25_200n, 1_000_000n)).toBeNull(); expect(payoutValue(1n, 21_000n, 1n)).toBeNull() })
  it('a bump is strictly higher (contract E_FEE_NOT_HIGHER) by at least 12.5%', () => {
    for (const p of [1n, 7n, 1_000_000n, 3_100_000_000n]) { const b = bumpedFee(p); expect(b).toBeGreaterThan(p); expect(b * 1000n).toBeGreaterThanOrEqual(p * 1125n) }
  })
  it('a bump stops at the cap', () => expect(bumpedFee(MAX_FEE_CAP_WEI)).toBe(MAX_FEE_CAP_WEI))
})
