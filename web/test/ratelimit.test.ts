import { describe, expect, it } from 'vitest'
import { MemKV } from './helpers'
import { consume, enforce, RULES } from '../functions/_lib/ratelimit'
import { ApiError } from '../functions/_lib/http'
import { laneDepth, serialize } from '../functions/_lib/lane'

const T = 1_700_000_000_000

describe('KV rate limits', () => {
  it('allows exactly `limit` requests per window then refuses', async () => {
    const kv = new MemKV()
    for (let i = 1; i <= 12; i++) expect((await consume(kv, RULES.previewMin, '1.1.1.1', T)).ok).toBe(true)
    const r = await consume(kv, RULES.previewMin, '1.1.1.1', T)
    expect(r.ok).toBe(false)
    expect(r.count).toBe(13)
    expect(r.retryAfter).toBeGreaterThanOrEqual(1)
    expect(r.retryAfter).toBeLessThanOrEqual(60)
  })
  it('counts each id separately', async () => {
    const kv = new MemKV()
    for (let i = 0; i < 3; i++) await consume(kv, RULES.guestIp, 'a', T)
    expect((await consume(kv, RULES.guestIp, 'a', T)).ok).toBe(false)
    expect((await consume(kv, RULES.guestIp, 'b', T)).ok).toBe(true)
  })
  it('a new window starts a fresh count', async () => {
    const kv = new MemKV()
    for (let i = 0; i < 12; i++) await consume(kv, RULES.previewMin, 'x', T)
    expect((await consume(kv, RULES.previewMin, 'x', T)).ok).toBe(false)
    expect((await consume(kv, RULES.previewMin, 'x', T + 61_000)).ok).toBe(true)
  })
  it('refused requests cost no KV writes', async () => {
    const kv = new MemKV()
    for (let i = 0; i < 12; i++) await consume(kv, RULES.previewMin, 'w', T)
    const puts = kv.puts
    await consume(kv, RULES.previewMin, 'w', T)
    expect(kv.puts).toBe(puts)
  })
  it('the global guest cap is 150 per day', async () => {
    const kv = new MemKV()
    for (let i = 0; i < 150; i++) expect((await consume(kv, RULES.guestGlobal, 'all', T)).ok).toBe(true)
    expect((await consume(kv, RULES.guestGlobal, 'all', T)).ok).toBe(false)
  })
  it('enforce throws a 429 { RATE_LIMITED } ApiError', async () => {
    const kv = new MemKV()
    const req = new Request('https://t.test/x', { headers: { 'cf-connecting-ip': '9.9.9.9' } })
    for (let i = 0; i < 6; i++) await enforce(kv, RULES.portraitGen, req)
    await expect(enforce(kv, RULES.portraitGen, req)).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' })
    await expect(enforce(kv, RULES.portraitGen, req)).rejects.toBeInstanceOf(ApiError)
  })
  it('limits match the spec: preview 12/min and 300/day, guest 3/IP/day, portrait and cry 6/min', () => {
    expect([RULES.previewMin.limit, RULES.previewDay.limit, RULES.previewDay.windowSec]).toEqual([12, 300, 86_400])
    expect([RULES.guestIp.limit, RULES.guestIp.windowSec]).toEqual([3, 86_400])
    expect([RULES.portraitGen.limit, RULES.cryGen.limit]).toEqual([6, 6])
  })

  describe('a parallel burst is counted exactly (read-then-write is serialized per key)', () => {
    /** A KV whose reads and writes yield, so an unserialized read-modify-write interleaves like the real thing. */
    class SlowKV extends MemKV {
      async get(key: string, type?: 'arrayBuffer'): Promise<any> { await new Promise((r) => setTimeout(r, 1)); return super.get(key, type as any) }
      async put(key: string, value: string | ArrayBuffer): Promise<void> { await new Promise((r) => setTimeout(r, 1)); return super.put(key, value) }
    }
    it('40 parallel preview calls against 12/min: exactly 12 pass, 28 are refused', async () => {
      const kv = new SlowKV()
      const rs = await Promise.all(Array.from({ length: 40 }, () => consume(kv, RULES.previewMin, 'burst', T)))
      expect(rs.filter((r) => r.ok).length).toBe(12)
      expect(rs.filter((r) => !r.ok).length).toBe(28)
    })
    it('the global guest cap holds under a burst and other ids are not blocked by it', async () => {
      const kv = new SlowKV()
      const rs = await Promise.all([...Array.from({ length: 160 }, () => consume(kv, RULES.guestGlobal, 'all', T)), consume(kv, RULES.guestIp, 'other', T)])
      expect(rs.slice(0, 160).filter((r) => r.ok).length).toBe(150)
      expect(rs[160]!.ok).toBe(true)
    })
    it('serialize runs one at a time, keeps order, survives a failure and cleans up', async () => {
      let running = 0
      let peak = 0
      const order: number[] = []
      const job = (i: number, fail = false) => serialize('k', async () => {
        running++; peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 2))
        running--; order.push(i)
        if (fail) throw new Error('boom')
        return i
      })
      const ps = [job(0), job(1, true), job(2), job(3)]
      expect(laneDepth('k')).toBe(4)
      const settled = await Promise.allSettled(ps)
      expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
      expect(peak).toBe(1)
      expect(order).toEqual([0, 1, 2, 3])
      await new Promise((r) => setTimeout(r, 5))
      expect(laneDepth('k')).toBe(0)
    })
  })
})
