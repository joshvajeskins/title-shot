//! Pure money and text rules: toll split, purse plan, sentence cleaning, payout value, nonce.
//! No host calls, so every rule here is a native property test (see `tests/economy_tests.rs`).
use near_sdk::AccountId;

pub const CHAMPION_PCT: u128 = 60;
pub const PROMOTER_PCT: u128 = 25;
pub const SIDE_POT_PCT: u128 = 10;
/// Largest toll the owner can configure (1,000,000 NEAR); keeps every `x * 60` far from u128 overflow.
pub const MAX_TOLL: u128 = 1_000_000_000_000_000_000_000_000_000_000;
/// Per-account cap on the pro-rata half of a purse: 25%.
pub const PURSE_CAP_PCT: u128 = 25;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    pub champion: u128,
    pub promoter: u128,
    pub side_pot: u128,
    pub protocol: u128,
}

impl Split {
    pub fn total(&self) -> u128 {
        self.champion + self.promoter + self.side_pot + self.protocol
    }
}

/// `R = toll - fee`; champion 60%, promoter 25%, side-pot 10%, protocol the exact remainder (>= 5%).
/// `champion + promoter + side_pot + protocol == toll - fee` always, to the yocto.
pub fn split_toll(toll: u128, fee: u128) -> Option<Split> {
    let r = toll.checked_sub(fee)?;
    if r > MAX_TOLL {
        return None;
    }
    let champion = r * CHAMPION_PCT / 100;
    let promoter = r * PROMOTER_PCT / 100;
    let side_pot = r * SIDE_POT_PCT / 100;
    Some(Split { champion, promoter, side_pot, protocol: r - champion - promoter - side_pot })
}

/// Anti-snipe purse split, aggregated per payee (holder first, then defenders in order).
/// * no bouts -> the whole purse back to the promoter
/// * else 50% to the final holder, 50% pro-rata to defence counts, each account's pro-rata share
///   capped at 25% of the purse; every remainder (caps, rounding, no defences) to the final holder.
/// The amounts sum to `purse` exactly and zero amounts are dropped.
pub fn plan_purse(
    purse: u128,
    promoter: &AccountId,
    final_holder: &AccountId,
    defenders: &[(AccountId, u32)],
    bouts: u32,
) -> Vec<(AccountId, u128)> {
    if purse == 0 {
        return vec![];
    }
    if bouts == 0 {
        return vec![(promoter.clone(), purse)];
    }
    let half = purse / 2;
    let pool = purse - half;
    let cap = purse * PURSE_CAP_PCT / 100;
    let total: u128 = defenders.iter().map(|(_, n)| *n as u128).sum();
    let mut out: Vec<(AccountId, u128)> = vec![(final_holder.clone(), half)];
    let mut paid = 0u128;
    if total > 0 {
        for (who, n) in defenders {
            let share = (pool * (*n as u128) / total).min(cap);
            if share == 0 {
                continue;
            }
            paid += share;
            match out.iter_mut().find(|(a, _)| a == who) {
                Some((_, amt)) => *amt += share,
                None => out.push((who.clone(), share)),
            }
        }
    }
    out[0].1 += pool - paid;
    out.retain(|(_, a)| *a > 0);
    out
}

/// Whitespace-collapsed sentence, validated with the shared rule (3..=120 chars, no control or
/// invisible/bidi characters). The cleaned string is what is hashed, sent to the AI and stored.
pub fn clean_sentence(s: &str) -> Result<String, &'static str> {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    bout_sim::spec::check_sentence(&collapsed).map_err(|_| crate::codes::E_SENTENCE)?;
    Ok(collapsed)
}

/// ETH value of a payout: `amount - gas_limit * max_fee_per_gas` (the payee pays the gas); `None`
/// when nothing would be left (dust) or the arithmetic overflows.
pub fn payout_value(amount_wei: u128, gas_limit: u64, max_fee_per_gas: u128) -> Option<u128> {
    let gas = (gas_limit as u128).checked_mul(max_fee_per_gas)?;
    amount_wei.checked_sub(gas).filter(|v| *v > 0)
}

pub const GWEI: u128 = 1_000_000_000;
pub const MAX_FEE_PER_GAS: u128 = 50 * GWEI;
pub const MIN_GAS_LIMIT: u64 = 21_000;
pub const MAX_GAS_LIMIT: u64 = 150_000;

/// A non-payee signing someone else's payout may burn at most 1% of it as gas.
pub const STRANGER_BURN_PCT: u128 = 1;
/// Largest purse the promoter can declare (1e24 wei = 1,000,000 ETH): keeps `purse * 25` and `pool * n` far from overflow.
pub const MAX_PURSE_WEI: u128 = 1_000_000_000_000_000_000_000_000;

/// Gas parameters a non-payee actually gets: the requested `max_fee` is lowered so `gas_limit * max_fee` stays within
/// `STRANGER_BURN_PCT` of the payout (never below 1 wei), and the priority fee follows it down. The payee's own
/// parameters are never clamped.
pub fn clamp_stranger_fee(amount_wei: u128, gas_limit: u64, max_fee: u128, max_prio: u128) -> (u128, u128) {
    let cap = amount_wei / 100 * STRANGER_BURN_PCT;
    let allowed = (cap / gas_limit.max(1) as u128).max(1);
    let fee = max_fee.min(allowed);
    (fee, max_prio.min(fee))
}

/// Gas parameter bounds for `sign_payout`.
pub fn gas_params_ok(max_fee: u128, max_prio: u128, gas_limit: u64) -> bool {
    (MIN_GAS_LIMIT..=MAX_GAS_LIMIT).contains(&gas_limit)
        && (1..=MAX_FEE_PER_GAS).contains(&max_fee)
        && max_prio <= max_fee
}

/// Sequential purse nonce: a payout keeps the nonce it was first given (retries reuse it);
/// a new payout takes the next one. Never skips, never repeats.
pub fn take_nonce(payout_nonce: &mut Option<u64>, next: &mut u64) -> u64 {
    if let Some(n) = *payout_nonce {
        return n;
    }
    let n = *next;
    *next += 1;
    *payout_nonce = Some(n);
    n
}
