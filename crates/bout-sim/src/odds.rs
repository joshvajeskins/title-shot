//! Win/draw/loss odds over `n` derived seeds (browser preview, "your odds" bar).

use crate::rng::Rng;
use crate::sim::winner_only;
use crate::spec::Spec;
use crate::types::Winner;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Odds {
    pub n: u32,
    pub champion: u32,
    pub draw: u32,
    pub challenger: u32,
    /// Percentages rounded to the nearest integer (they may sum to 99..=101).
    pub champion_pct: u32,
    pub draw_pct: u32,
    pub challenger_pct: u32,
}

pub const MAX_ODDS_N: u32 = 2000;

/// Fight `n` times with seeds derived from `seed` (n is capped at `MAX_ODDS_N`).
pub fn odds(champ: &Spec, chall: &Spec, seed: [u8; 32], rule: u8, n: u32) -> Odds {
    let n = n.clamp(1, MAX_ODDS_N);
    let mut rng = Rng::from_seed(&seed);
    let (mut c, mut d, mut h) = (0u32, 0u32, 0u32);
    for _ in 0..n {
        let s = rng.seed32();
        match winner_only(champ, chall, &s, rule).winner {
            Winner::Champion => c += 1,
            Winner::Draw => d += 1,
            Winner::Challenger => h += 1,
        }
    }
    let pct = |x: u32| (x * 100 + n / 2) / n;
    Odds { n, champion: c, draw: d, challenger: h, champion_pct: pct(c), draw_pct: pct(d), challenger_pct: pct(h) }
}
