import { Icon } from '../components/Icon'
import { nearRocksTx, type CheatId, type CheatResult, type Planned } from '../game/cheats'

export type Stage = 'idle' | 'approve' | 'sending' | 'reading' | 'done' | 'error'
export interface CardState { stage: Stage; result?: CheatResult; error?: string }

interface Copy { title: string; tried: (target: string) => string; why: string }
export const COPY: Record<CheatId, Copy> = {
  forge: {
    title: 'Deliver my own fighter',
    tried: (t) => `Hand the contract a fighter with every stat at 10 for ${t}, as if NEAR AI had compiled it.`,
    why: 'Only a listed relayer may deliver a compile. Even a relayer’s delivery is rebuilt from the challenge’s own sentence and checked against NEAR AI’s signature with ecrecover: the recorded samples below are the relayer itself being refused (E_AI_SIG).',
  },
  claim: {
    title: 'Claim someone else’s purse share',
    tried: (t) => `Name my own Base address for ${t}.`,
    why: 'Only the payee of a purse share can say where it is paid, and only once.',
  },
  belt: {
    title: 'Take a belt I don’t hold',
    tried: (t) => `Transfer ${t} to myself with nft_transfer.`,
    why: 'Only the holder can move a belt token, and never to itself. A belt changes hands by winning a bout.',
  },
  withdraw: {
    title: 'Withdraw more than I have',
    tried: (t) => `Ask for 340 trillion NEAR, more than exists, out of ${t}.`,
    why: 'A withdrawal must fit the caller’s game balance to the yoctoNEAR.',
  },
}

const callOf = (p: Planned): string => {
  if (!('plan' in p)) return ''
  const a = p.plan.args
  switch (p.plan.method) {
    case 'submit_forge': return `submit_forge(${a.challenge_id}, {power: 10, speed: 10, guard: 10, …})`
    case 'claim_payout': return `claim_payout(${a.payout_id}, "0x…dEaD")`
    case 'nft_transfer': return `nft_transfer(${a.receiver_id ? `"${a.receiver_id}"` : 'you'}, "${a.token_id}")`
    case 'withdraw': return 'withdraw(340282366920938463463374607431768211455)'
  }
}

const nearOf = (yocto: bigint): string => {
  const n = Number(yocto) / 1e24
  return n === 0 ? '0' : n < 0.00001 ? '<0.00001' : n.toFixed(5)
}
const tgas = (g: bigint): string => (Number(g) / 1e12).toFixed(1)

const BUSY: Partial<Record<Stage, string>> = { approve: 'Approve it in your wallet…', sending: 'Sending…', reading: 'Reading the outcome from the chain…' }

export function CheatCard({ id, n, planned, state, canSend, onSend }: { id: CheatId; n: number; planned: Planned; state: CardState; canSend: boolean; onSend: () => void }) {
  const c = COPY[id]
  const plan = 'plan' in planned ? planned.plan : null
  const busy = BUSY[state.stage]
  const r = state.result
  return (
    <li className={`cheat-card s-${state.stage}${r?.succeeded ? ' is-through' : ''}`}>
      <div className="cheat-top">
        <span className="cheat-n display">{String(n).padStart(2, '0')}</span>
        <h3 className="display cheat-title">{c.title}</h3>
      </div>
      {plan ? (
        <>
          <p className="cheat-tried">{c.tried(plan.target)}</p>
          <code className="mono cheat-call">{callOf(planned)}</code>
          <p className="cheat-meta">
            <span className="chip">expect {plan.expect}</span>
            <span className="tape-dim">{plan.deposit ? 'gas + 1 yoctoNEAR (returned on refusal)' : 'gas only'}</span>
          </p>
        </>
      ) : <p className="cheat-tried tape-dim">{'blocked' in planned ? planned.blocked : ''}</p>}

      <div className="cheat-out" aria-live="polite">
        {busy ? <p className="cheat-busy"><span className="cheat-dot" aria-hidden="true" />{busy}</p> : null}
        {state.stage === 'error' ? <p className="cheat-err">{state.error}</p> : null}
        {r ? (
          <div className="cheat-result">
            <span className={`cheat-stamp display${r.succeeded ? ' stamp-through' : ''}`}>{r.succeeded ? 'It went through' : 'Refused'}</span>
            <dl className="cheat-facts">
              <div><dt>Code on chain</dt><dd><code className="mono">{r.succeeded ? 'none' : r.code ?? 'no E_ code'}</code>{plan && r.code === plan.expect ? <span className="cheat-match"><Icon name="check" size={13} /> as the source says</span> : null}</dd></div>
              <div><dt>Gas spent</dt><dd className="num">{nearOf(r.burntYocto)} NEAR <span className="tape-dim">· {tgas(r.gasBurnt)} Tgas</span></dd></div>
              <div><dt>Transaction</dt><dd><a href={nearRocksTx(r.hash)} target="_blank" rel="noreferrer" className="mono">{r.hash.slice(0, 10)}… <Icon name="external" size={12} /></a></dd></div>
            </dl>
            {!r.succeeded ? <p className="cheat-why">{c.why}</p> : null}
          </div>
        ) : null}
      </div>

      <button type="button" className="btn btn-red btn-sm cheat-go" disabled={!plan || !canSend || !!busy} onClick={onSend}>
        {r || state.stage === 'error' ? 'Try it again' : 'Send it'}
      </button>
    </li>
  )
}
