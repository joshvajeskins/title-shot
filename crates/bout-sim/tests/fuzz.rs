mod common;
use bout_sim::rng::Rng;
use bout_sim::spec::*;
use bout_sim::testgen::{random_raw, random_spec};
use bout_sim::{normalize, normalize_str, simulate, simulate_lite, Spec};
use common::*;

fn junk_string(rng: &mut Rng) -> String {
    let n = rng.below(60);
    (0..n)
        .map(|_| {
            let c = match rng.below(8) {
                0 => rng.below(0x20),
                1 => 0x7F + rng.below(0x30),
                2 => 0x200B + rng.below(0x40),
                3 => 0x1F300 + rng.below(0x300),
                4 => 0x4E00 + rng.below(300),
                _ => 0x20 + rng.below(0x5F),
            };
            char::from_u32(c).unwrap_or('?')
        })
        .collect()
}

#[test]
fn normalize_never_panics_on_junk_raws() {
    let mut rng = Rng::from_u64(31337);
    let (mut ok, mut bad) = (0, 0);
    for i in 0..20_000 {
        let mut r = random_raw(&mut rng, i % 2 == 0);
        match rng.below(10) {
            0 => r.name = junk_string(&mut rng),
            1 => r.look = junk_string(&mut rng),
            2 => r.school = junk_string(&mut rng),
            3 => r.moves[rng.below(3) as usize].id = junk_string(&mut rng),
            4 => r.moves[rng.below(3) as usize].label = junk_string(&mut rng),
            5 => r.weights.grit = (rng.next_u64() as i64).wrapping_mul(if rng.below(2) == 0 { 1 } else { -1 }),
            6 => r.moves.truncate(rng.below(5) as usize),
            7 => r.verdict = junk_string(&mut rng),
            _ => {}
        }
        match normalize(&r) {
            Ok(s) => {
                ok += 1;
                assert_eq!(s.stats.sum() + s.move_costs(), 100);
                let again = Spec::from_json(&serde_json::to_string(&s).unwrap()).unwrap();
                assert_eq!(again, s);
            }
            Err(e) => {
                bad += 1;
                assert!(ALL_CODES.contains(&e.code()));
            }
        }
    }
    assert!(ok > 1000 && bad > 1000, "{ok} {bad}");
}

#[test]
fn normalize_str_never_panics_on_mutated_json() {
    let mut rng = Rng::from_u64(4242);
    let good = serde_json::to_string(&base_raw()).unwrap();
    let bytes = good.as_bytes().to_vec();
    for _ in 0..20_000 {
        let mut b = bytes.clone();
        for _ in 0..1 + rng.below(4) {
            let i = rng.below(b.len() as u32) as usize;
            match rng.below(3) {
                0 => b[i] = rng.below(256) as u8,
                1 => {
                    b.remove(i);
                }
                _ => b.insert(i, rng.below(128) as u8),
            }
        }
        let s = String::from_utf8_lossy(&b).to_string();
        let _ = normalize_str(&s);
        let _ = Spec::from_json(&s);
    }
    for s in ["", "{}", "[]", "null", "\"x\"", "{\"verdict\":\"ok\"}", &"[".repeat(500)] {
        assert!(normalize_str(s).is_err());
    }
}

#[test]
fn simulate_never_panics_for_any_seed_rule_or_spec() {
    let mut rng = Rng::from_u64(99);
    for i in 0..4000 {
        let a = random_spec(&mut rng, i % 2 == 0);
        let b = random_spec(&mut rng, i % 5 == 0);
        let rule = rng.below(256) as u8;
        let seed = rng.seed32();
        let f = simulate(&a, &b, seed, rule);
        check_fight(&f);
        assert_eq!(simulate_lite(&a, &b, seed, rule), (f.winner, f.state_hash));
    }
    // degenerate seeds
    let s = arch_specs();
    for seed in [[0u8; 32], [255u8; 32], [1u8; 32]] {
        check_fight(&simulate(&s[0], &s[1], seed, 0));
    }
}

#[test]
fn extreme_stat_spreads_never_overflow() {
    for w in [[10, 1, 1, 1], [1, 10, 1, 1], [1, 1, 10, 1], [1, 1, 1, 10]] {
        for v in [[10, 1, 1, 1], [1, 10, 1, 1], [1, 1, 10, 1], [1, 1, 1, 10]] {
            let mk = |w: [i64; 4]| {
                let mut r = base_raw();
                r.weights = RawWeights { power: w[0], guard: w[1], speed: w[2], grit: w[3] };
                normalize(&r).unwrap()
            };
            for rule in 0..8 {
                check_fight(&simulate(&mk(w), &mk(v), seed(rule as u64), rule));
            }
        }
    }
}
