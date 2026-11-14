//! Money rules from docs/CONTRACT.md, written out independently of the contract (integer math only).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    pub champion: u128,
    pub promoter: u128,
    pub side_pot: u128,
    pub protocol: u128,
}

/// R = T - F; champion R*60/100, promoter R*25/100, side-pot R*10/100, protocol = the exact remainder.
pub fn split(toll: u128, fee: u128) -> Split {
    let r = toll - fee;
    let (champion, promoter, side_pot) = (r * 60 / 100, r * 25 / 100, r * 10 / 100);
    Split { champion, promoter, side_pot, protocol: r - champion - promoter - side_pot }
}

/// Purse plan: (account label, wei). `defences`: (account, successful defences). Aggregated per payee.
/// No challenge -> everything to the promoter. Else half to the final holder, half pro-rata to defence counts
/// with every account capped at 25% of the purse; all remainders to the final holder.
pub fn purse(purse: u128, challenges: u32, promoter: &str, holder: &str, defences: &[(&str, u32)]) -> Vec<(String, u128)> {
    if challenges == 0 {
        return vec![(promoter.to_string(), purse)];
    }
    let half = purse / 2;
    let pool = purse - half;
    let cap = purse * 25 / 100;
    let total: u128 = defences.iter().map(|(_, n)| *n as u128).sum();
    let mut out: Vec<(String, u128)> = vec![];
    let mut paid = 0u128;
    if total > 0 {
        for (who, n) in defences {
            let share = (pool * *n as u128 / total).min(cap);
            paid += share;
            add(&mut out, who, share);
        }
    }
    add(&mut out, holder, purse - paid);
    out.retain(|(_, v)| *v > 0);
    assert_eq!(out.iter().map(|(_, v)| *v).sum::<u128>(), purse);
    out
}

fn add(out: &mut Vec<(String, u128)>, who: &str, v: u128) {
    match out.iter_mut().find(|(w, _)| w == who) {
        Some(e) => e.1 += v,
        None => out.push((who.to_string(), v)),
    }
}

/// Payout value when the payee pays gas: amount - gas_limit * max_fee_per_gas (None if <= 0).
pub fn payout_value(amount_wei: u128, gas_limit: u64, max_fee: u128) -> Option<u128> {
    amount_wei.checked_sub(gas_limit as u128 * max_fee).filter(|v| *v > 0)
}
