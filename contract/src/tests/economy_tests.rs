//! Native property tests of the pure rules (no host calls): split, purse plan, sentence cleaning, nonce, payout math.
use crate::economy::*;
use near_sdk::AccountId;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn u128_below(&mut self, n: u128) -> u128 {
        (((self.next() as u128) << 64) | self.next() as u128) % n
    }
}

fn acct(i: u64) -> AccountId {
    format!("player{i}.testnet").parse().unwrap()
}

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

#[test]
fn split_conserves_the_toll_to_the_yocto_over_5000_random_tolls_and_fees() {
    let mut r = Rng(1);
    for _ in 0..5000 {
        let toll = 1 + r.u128_below(MAX_TOLL);
        let fee = r.u128_below(toll + 1);
        let s = split_toll(toll, fee).expect("fee <= toll");
        assert_eq!(s.total() + fee, toll, "toll {toll} fee {fee}");
        assert_eq!(s.champion, (toll - fee) * 60 / 100);
        assert!(s.protocol >= (toll - fee) * 5 / 100, "protocol keeps at least 5%");
    }
    // Small and edge values.
    for toll in 0..400u128 {
        for fee in 0..=toll {
            let s = split_toll(toll, fee).unwrap();
            assert_eq!(s.total() + fee, toll);
        }
    }
    assert!(split_toll(5, 6).is_none(), "fee above toll is refused");
    assert!(split_toll(MAX_TOLL + 1, 0).is_none(), "toll above the cap is refused");
    let s = split_toll(NEAR / 10, NEAR / 100).unwrap();
    assert_eq!((s.champion, s.promoter, s.side_pot, s.protocol), (54 * NEAR / 1000, 225 * NEAR / 10000, 9 * NEAR / 1000, 45 * NEAR / 10000));
}

#[test]
fn self_dealing_is_strictly_negative_for_any_toll_and_fee() {
    let mut r = Rng(2);
    for _ in 0..3000 {
        let toll = 2 + r.u128_below(MAX_TOLL - 2);
        let fee = 1 + r.u128_below(toll - 1);
        let s = split_toll(toll, fee).unwrap();
        // One person holds the belt, promotes and takes the side-pot: gets champion + promoter + side_pot back.
        let best_colluder = s.champion + s.promoter + s.side_pot;
        assert!(best_colluder < toll, "colluder must lose: toll {toll} fee {fee}");
        // Even owning the protocol too (the owner), the whole of R is returned, never the fee.
        assert!(best_colluder + s.protocol < toll);
        assert_eq!(toll - (best_colluder + s.protocol), fee);
    }
}

fn plan_sum(plan: &[(AccountId, u128)]) -> u128 {
    plan.iter().map(|(_, a)| *a).sum()
}

#[test]
fn purse_plan_conserves_the_purse_and_caps_pro_rata_shares_over_3000_random_seasons() {
    let mut r = Rng(3);
    let promoter = acct(900);
    for _ in 0..3000 {
        let purse = r.u128_below(100 * NEAR);
        let holder = acct(r.below(5));
        let n_def = r.below(7);
        let defenders: Vec<(AccountId, u32)> = (0..n_def).map(|i| (acct(10 + i), 1 + r.below(30) as u32)).collect();
        let bouts = if r.below(8) == 0 { 0 } else { 1 + r.below(50) as u32 };
        let plan = plan_purse(purse, &promoter, &holder, &defenders, bouts);
        assert_eq!(plan_sum(&plan), purse, "purse {purse} bouts {bouts}");
        assert!(plan.iter().all(|(_, a)| *a > 0), "zero amounts are dropped");
        let mut seen: Vec<&AccountId> = plan.iter().map(|(a, _)| a).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), plan.len(), "one payout per payee");
        if bouts > 0 {
            for (who, amt) in &plan {
                if *who != holder {
                    assert!(*amt <= purse * 25 / 100, "non-holder payee capped at 25%: {amt} of {purse}");
                }
            }
            let holder_amt = plan.iter().find(|(a, _)| *a == holder).map(|(_, a)| *a).unwrap_or(0);
            assert!(holder_amt >= purse / 2, "final holder gets at least half");
        }
    }
}

#[test]
fn purse_plan_with_zero_bouts_returns_the_whole_purse_to_the_promoter() {
    let plan = plan_purse(7 * NEAR, &acct(1), &acct(2), &[(acct(3), 4)], 0);
    assert_eq!(plan, vec![(acct(1), 7 * NEAR)]);
    assert!(plan_purse(0, &acct(1), &acct(2), &[], 5).is_empty());
}

#[test]
fn purse_plan_anti_snipe_one_defender_is_capped_and_the_rest_goes_to_the_holder() {
    // 100 units, one defender with all the defences: pro-rata half (50) is capped at 25; holder keeps 75.
    let plan = plan_purse(100, &acct(1), &acct(2), &[(acct(3), 9)], 9);
    assert_eq!(plan, vec![(acct(2), 75), (acct(3), 25)]);
    // The holder defending is merged into one payout.
    let plan = plan_purse(100, &acct(1), &acct(2), &[(acct(2), 9)], 9);
    assert_eq!(plan, vec![(acct(2), 100 - 0)]);
    // No defences at all: everything to the final holder.
    assert_eq!(plan_purse(100, &acct(1), &acct(2), &[], 3), vec![(acct(2), 100)]);
    // Four equal defenders: 12 each (50/4), under the 25 cap.
    let plan = plan_purse(100, &acct(1), &acct(2), &[(acct(3), 1), (acct(4), 1), (acct(5), 1), (acct(6), 1)], 4);
    assert_eq!(plan_sum(&plan), 100);
    assert_eq!(plan.iter().find(|(a, _)| *a == acct(4)).unwrap().1, 12);
}

#[test]
fn sentence_cleaning_trims_collapses_and_enforces_length_and_characters() {
    assert_eq!(clean_sentence("  I punch\tlike   a\nmonday  ").unwrap(), "I punch like a monday");
    assert_eq!(clean_sentence("abc").unwrap(), "abc");
    assert_eq!(clean_sentence("ab"), Err("E_SENTENCE"));
    assert_eq!(clean_sentence("   a   b  ").unwrap(), "a b");
    assert_eq!(clean_sentence("   a    "), Err("E_SENTENCE"), "3 chars needed after collapsing");
    assert_eq!(clean_sentence(&"x".repeat(120)).unwrap().len(), 120);
    assert_eq!(clean_sentence(&"x".repeat(121)), Err("E_SENTENCE"));
    assert_eq!(clean_sentence("hello\u{0}world"), Err("E_SENTENCE"), "NUL");
    assert_eq!(clean_sentence("hello\u{200B}world"), Err("E_SENTENCE"), "zero width space");
    assert_eq!(clean_sentence("hello\u{202E}world"), Err("E_SENTENCE"), "bidi override");
    assert_eq!(clean_sentence("naïve café 🥊 fighter").unwrap(), "naïve café 🥊 fighter");
    // 120 emoji chars is fine (length is in chars), 121 is not.
    assert!(clean_sentence(&"🥊".repeat(120)).is_ok());
    assert!(clean_sentence(&"🥊".repeat(121)).is_err());
    assert_eq!(clean_sentence("a\u{00A0}b\u{00A0}c").unwrap(), "a b c", "NBSP is whitespace");
}

#[test]
fn nonce_sequencing_never_skips_or_repeats_and_retries_keep_their_nonce() {
    let mut next = 0u64;
    let mut payouts: Vec<Option<u64>> = vec![None; 5];
    let mut got = vec![];
    for p in payouts.iter_mut() {
        got.push(take_nonce(p, &mut next));
    }
    assert_eq!(got, vec![0, 1, 2, 3, 4]);
    assert_eq!(next, 5);
    // A retry of payout #2 (signing failed) reuses its nonce and does not advance the counter.
    assert_eq!(take_nonce(&mut payouts[2], &mut next), 2);
    assert_eq!(next, 5);
    let mut fresh = None;
    assert_eq!(take_nonce(&mut fresh, &mut next), 5);
}

#[test]
fn payout_value_math_makes_the_payee_pay_the_gas_and_refuses_dust() {
    let gwei = GWEI;
    assert_eq!(payout_value(1_000_000_000_000_000, 60_000, 3 * gwei), Some(1_000_000_000_000_000 - 60_000 * 3 * gwei));
    assert_eq!(payout_value(60_000 * 3 * gwei, 60_000, 3 * gwei), None, "exactly the gas leaves nothing");
    assert_eq!(payout_value(60_000 * 3 * gwei + 1, 60_000, 3 * gwei), Some(1));
    assert_eq!(payout_value(10, 21_000, 1), None, "gas larger than amount");
    assert_eq!(payout_value(u128::MAX, u64::MAX, u128::MAX), None, "overflow is dust, not a panic");
    let mut r = Rng(4);
    for _ in 0..2000 {
        let amount = r.u128_below(NEAR);
        let gas = 21_000 + r.below(129_000);
        let fee = 1 + r.u128_below(50 * gwei);
        if let Some(v) = payout_value(amount, gas, fee) {
            assert_eq!(v + gas as u128 * fee, amount);
        }
    }
}

#[test]
fn gas_parameter_bounds() {
    assert!(gas_params_ok(GWEI, GWEI / 100, 21_000));
    assert!(gas_params_ok(50 * GWEI, 50 * GWEI, 150_000));
    assert!(!gas_params_ok(GWEI, 0, 20_999), "below 21000");
    assert!(!gas_params_ok(GWEI, 0, 150_001), "above 150000");
    assert!(!gas_params_ok(50 * GWEI + 1, 0, 60_000), "fee above 50 gwei");
    assert!(!gas_params_ok(0, 0, 60_000), "zero fee");
    assert!(!gas_params_ok(GWEI, GWEI + 1, 60_000), "priority above max fee");
}
