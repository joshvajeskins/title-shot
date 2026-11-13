mod common;
use bout_sim::tune::*;
use bout_sim::{normalize, simulate_lite, types::Winner};
use bout_sim::spec::{RawMove, RawWeights, Raw};
use common::*;

fn raw_with(school: &str, style: &str, ids: [&str; 3], w: [i64; 4]) -> Raw {
    let mut r = base_raw();
    r.school = school.into();
    r.style = style.into();
    r.moves = ids.iter().map(|i| RawMove { id: (*i).into(), label: format!("{i} label") }).collect();
    r.weights = RawWeights { power: w[0], guard: w[1], speed: w[2], grit: w[3] };
    r
}

#[test]
fn stat_knee_is_monotone_and_halves_the_overflow() {
    assert_eq!((eff(5), eff(20), eff(21), eff(22), eff(45)), (5, 20, 20, 21, 32));
    for x in 5..45 {
        assert!(eff(x + 1) >= eff(x), "{x}");
        assert!(eff(x) <= x);
    }
}

#[test]
fn a_maxed_single_stat_loses_to_an_even_build_with_the_same_moves() {
    let moves = ["iron_fist", "wave_slap", "bulwark"];
    let even = normalize(&raw_with("IRON", "BRAWLER", moves, [5, 5, 5, 5])).unwrap();
    let lopsided = normalize(&raw_with("IRON", "BRAWLER", moves, [10, 1, 1, 1])).unwrap();
    assert!(lopsided.stats.power > STAT_KNEE as u8 + 10 && even.stats.power <= 20);
    let (mut even_wins, mut lop_wins) = (0, 0);
    for i in 0..600u64 {
        let seed = bout_sim::rng::Rng::from_u64(0xE0 + i).seed32();
        let (a, b) = if i % 2 == 0 { (&even, &lopsided) } else { (&lopsided, &even) };
        match simulate_lite(a, b, seed, (i % 8) as u8).0 {
            Winner::Draw => {}
            Winner::Champion => if i % 2 == 0 { even_wins += 1 } else { lop_wins += 1 },
            Winner::Challenger => if i % 2 == 0 { lop_wins += 1 } else { even_wins += 1 },
        }
    }
    assert!(even_wins > lop_wins + 60, "even {even_wins} vs lopsided {lop_wins}");
}
