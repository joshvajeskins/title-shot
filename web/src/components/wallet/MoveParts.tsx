// The move's confirmation (exactly what goes where) and its live step list with explorer links.
import type { MovePlan, MoveStep, MoveStepId } from '../../game/wallet/move'
import { near } from '../../lib/format'
import { Icon } from '../Icon'

/** Nothing worth a transaction: no game balance, no belt, no spare NEAR. */
export const isEmpty = (p: MovePlan): boolean => p.balance <= 0n && p.belts.length === 0 && p.accountNear <= 0n

export function MoveReview({ plan, walletName }: { plan: MovePlan; walletName: string }) {
  const total = plan.balance + plan.accountNear
  return (
    <div className="wm-review">
      <div className="wm-to">
        <span className="eyebrow">To</span>
        <strong className="display" title={plan.target}>{plan.target}</strong>
        <small><Icon name="check" size={12} /> Proved yours with a signed message in {walletName}</small>
      </div>
      <ul className="wm-lines">
        <li><span>Game balance</span><b className="num">{near(plan.balance, 4)} NEAR</b><em>withdrawn, then sent</em></li>
        <li>
          <span>Belts</span>
          <b>{plan.belts.length ? plan.belts.map((b) => b.name).join(', ') : 'None held'}</b>
          <em>{plan.belts.length ? 'NEP-171 nft_transfer: the champion\'s share follows the belt' : 'nothing to transfer'}</em>
        </li>
        <li><span>Account NEAR</span><b className="num">{near(plan.accountNear, 4)} NEAR</b><em>{near(plan.reserve, 3)} NEAR stays behind for the guest's storage and gas</em></li>
        <li className="wm-total"><span>Arriving</span><b className="num">≈ {near(total, 4)} NEAR{plan.belts.length ? ` + ${plan.belts.length} belt${plan.belts.length > 1 ? 's' : ''}` : ''}</b></li>
      </ul>
      {plan.pending
        ? <p className="wm-err" role="alert"><Icon name="lock" size={14} /> A fight of yours is still being forged, so its toll is locked. Move once it has finished.</p>
        : isEmpty(plan) ? <p className="wm-err" role="status"><Icon name="info" size={14} /> Nothing to move: this guest corner holds no balance, no belt and no spare NEAR.</p>
        : <p className="wm-note">Signed here by the guest's own full-access key: up to three transactions, no wallet popup. The wallet is never asked to sign anything to receive.</p>}
    </div>
  )
}

const LABEL: Record<MoveStepId, (p: MovePlan) => string> = {
  withdraw: (p) => `Withdraw ${near(p.balance, 4)} NEAR game balance`,
  belts: (p) => (p.belts.length ? `Transfer ${p.belts.map((b) => b.name).join(', ')}` : 'Transfer belts'),
  near: (p) => `Send the account's NEAR to ${p.target}`,
}

export function MoveSteps({ plan, steps }: { plan: MovePlan; steps: Partial<Record<MoveStepId, MoveStep>> }) {
  return (
    <ol className="wm-steps">
      {(['withdraw', 'belts', 'near'] as const).map((id) => {
        const s = steps[id]
        const status = s?.status ?? 'waiting'
        return (
          <li key={id} className={`is-${status}`}>
            <span className="wm-step-icon" aria-hidden="true">{status === 'done' ? <Icon name="check" size={14} /> : status === 'failed' ? <Icon name="x" size={14} /> : status === 'running' ? <span className="ew-dot" /> : status === 'skipped' ? '–' : ''}</span>
            <span className="wm-step-text">
              <span>{LABEL[id](plan)}</span>
              {status === 'skipped' && <small>Nothing to move</small>}
              {status === 'failed' && s?.note && <small className="wm-step-err">{s.note}</small>}
              {s?.receipt && <a href={s.receipt.url} target="_blank" rel="noreferrer" className="num">{s.receipt.tx.slice(0, 10)}… on NearBlocks <Icon name="external" size={11} /></a>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
