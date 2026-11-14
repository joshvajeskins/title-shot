// A send that ended in RpcUnavailable may have landed: the retry must re-send the same signed bytes (or find the tx by
// hash), never sign a second transaction that would deposit twice.
import { describe, expect, it } from 'vitest'
import { decodeSignedTransaction } from '@near-js/transactions'
import { Rpc } from '../src/game/chain/rpc'
import { Signer } from '../src/game/chain/signer'
import { fn } from '../src/game/chain/tx'
import { generateKeyPair } from '../src/game/chain/keys'
import { fromB64 } from '../src/game/chain/bytes'

const SPONSOR = 'play.titleshot.testnet'
const CONTRACT = 'titleshot.testnet'

interface Net {
  /** what the send_tx call does for the nth attempt (1-based): 'ok', 'down' (every node fails), 'nonce' (InvalidNonce) */
  send: (n: number) => 'ok' | 'down' | 'nonce'
  /** the chain already holds a tx with this base64 once it was 'ok'-ed, or when `landedDespiteDown` */
  landedDespiteDown?: boolean
  txKnown?: 'yes' | 'no' | 'error'
  /** answers to successive tx-status lookups (overrides txKnown): a lagging node says 'no' before one that is ahead says 'yes' */
  txSeq?: ('yes' | 'no')[]
}

function rig(net: Net) {
  const sends: string[] = []
  let attempts = 0
  let chainNonce = 10
  const landed = new Set<string>()
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
    const err = (cause: string, message = cause) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: cause }, message, data: message } }))
    if (method === 'query' && params.request_type === 'view_access_key') return ok({ nonce: chainNonce })
    if (method === 'block') return ok({ header: { hash: '11111111111111111111111111111111' } })
    if (method === 'send_tx') {
      attempts++
      const b64 = params.signed_tx_base64 as string
      sends.push(b64)
      const what = net.send(attempts)
      if (what === 'down') { if (net.landedDespiteDown) { landed.add(b64); chainNonce = Number(decodeSignedTransaction(fromB64(b64)).transaction.nonce) } return new Response('bad gateway', { status: 502 }) }
      if (what === 'nonce') return err('INVALID_TRANSACTION', 'InvalidNonce { tx_nonce: 11, ak_nonce: 11 }')
      landed.add(b64)
      return ok({})
    }
    if (method === 'tx') {
      if (net.txSeq?.length) return net.txSeq.shift() === 'yes' ? ok({ final_execution_status: 'INCLUDED', status: { SuccessValue: '' }, transaction: {} }) : err('UNKNOWN_TRANSACTION')
      if (net.txKnown === 'error') return new Response('bad gateway', { status: 502 })
      return net.txKnown === 'yes' ? ok({ final_execution_status: 'INCLUDED', status: { SuccessValue: '' }, transaction: {} }) : err('UNKNOWN_TRANSACTION')
    }
    return err('UNKNOWN_METHOD', method)
  }) as unknown as typeof fetch
  const rpc = new Rpc({ fetchFn, urls: ['https://a.test'] })
  const signer = new Signer(SPONSOR, generateKeyPair(), rpc, { confirmGapMs: 5 })
  return { signer, sends }
}

const deposit = () => [fn('deposit_for', { account: 'x.play.titleshot.testnet' }, 30_000_000_000_000n, 300_000_000_000_000_000_000_000n)]
const nonceOf = (b64: string) => decodeSignedTransaction(fromB64(b64)).transaction.nonce

describe('Signer retries after RpcUnavailable', () => {
  it('re-sends the identical signed bytes (same nonce, same hash) and returns the hash of the one transaction', async () => {
    const { signer, sends } = rig({ send: (n) => (n <= 2 ? 'down' : 'ok'), landedDespiteDown: true })
    const hash = await signer.send(CONTRACT, deposit())
    expect(sends.length).toBeGreaterThanOrEqual(3)
    expect(new Set(sends).size).toBe(1) // one transaction, however many times it was sent
    expect(hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
  })

  it('deposit_for is not double-sent: the first send landed but looked failed, the retry gets InvalidNonce, the tx is found by hash and no second tx is signed', async () => {
    const { signer, sends } = rig({ send: (n) => (n === 1 ? 'down' : 'nonce'), landedDespiteDown: true, txKnown: 'yes' })
    const hash = await signer.send(CONTRACT, deposit())
    expect(new Set(sends).size).toBe(1) // never signed a different transaction
    expect(sends.length).toBe(2)
    expect(hash).toBeTruthy()
  })

  it('if the earlier send is not on chain and the nonce is stale, a new transaction is signed with a fresh nonce', async () => {
    const { signer, sends } = rig({ send: (n) => (n === 1 ? 'down' : n === 2 ? 'nonce' : 'ok'), txKnown: 'no' })
    await signer.send(CONTRACT, deposit())
    expect(new Set(sends).size).toBe(2)
    expect(nonceOf(sends[2]!)).toBeGreaterThan(nonceOf(sends[0]!))
  })

  it('a lagging node answering UNKNOWN_TRANSACTION is not proof: the ambiguous hash is looked up again before a second tx is signed', async () => {
    const { signer, sends } = rig({ send: (n) => (n === 1 ? 'down' : 'nonce'), landedDespiteDown: true, txSeq: ['no', 'no', 'yes'] })
    const hash = await signer.send(CONTRACT, deposit())
    expect(new Set(sends).size).toBe(1) // the deposit was never signed twice
    expect(hash).toBeTruthy()
  })

  it('if the chain cannot say whether the earlier send landed, it gives up with the error instead of signing on a guess', async () => {
    const { signer, sends } = rig({ send: (n) => (n === 1 ? 'down' : 'nonce'), txKnown: 'error' })
    await expect(signer.send(CONTRACT, deposit())).rejects.toThrow()
    expect(new Set(sends).size).toBe(1)
  })

  it('a plain stale nonce (nothing ambiguous) still re-signs with a new nonce', async () => {
    const { signer, sends } = rig({ send: (n) => (n === 1 ? 'nonce' : 'ok') })
    await signer.send(CONTRACT, deposit())
    expect(new Set(sends).size).toBe(2)
  })

  it('a persistent outage gives up after a bounded number of attempts, all with the same bytes', async () => {
    const { signer, sends } = rig({ send: () => 'down' })
    await expect(signer.send(CONTRACT, deposit())).rejects.toThrow(/unavailable/i)
    expect(sends.length).toBe(5)
    expect(new Set(sends).size).toBe(1)
  })

  it('other errors are thrown at once, not retried', async () => {
    const { signer, sends } = rig({ send: () => 'ok' })
    const rpc = signer.rpc as Rpc
    rpc.sendAsync = async () => { throw new Error('Actions are invalid') }
    await expect(signer.send(CONTRACT, deposit())).rejects.toThrow('Actions are invalid')
    expect(sends.length).toBe(0)
  })
})
