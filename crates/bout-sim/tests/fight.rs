mod common;
use bout_sim::events::{Event, Outcome};
use bout_sim::moves::{self, LIBRARY};
use bout_sim::odds::odds;
use bout_sim::rng::Rng;
use bout_sim::spec::*;
use bout_sim::testgen::{random_raw, random_spec};
use bout_sim::tune::*;
use bout_sim::types::Winner;
use bout_sim::{normalize, simulate, simulate_lite};
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
fn simulation_is_deterministic_and_lite_matches() {
    let specs = arch_specs();
    for i in 0..60u64 {
        let (a, b) = (&specs[(i as usize * 3) % 40], &specs[(i as usize * 7 + 1) % 40]);
        let s = seed(i);
        let f1 = simulate(a, b, s, (i % 8) as u8);
        let f2 = simulate(a, b, s, (i % 8) as u8);
        assert_eq!(f1.state_hash, f2.state_hash);
        assert_eq!(f1.events, f2.events);
        let (w, h) = simulate_lite(a, b, s, (i % 8) as u8);
        assert_eq!((w, h), (f1.winner, f1.state_hash));
        check_fight(&f1);
    }
}

#[test]
fn seed_rule_and_side_change_the_hash() {
    let specs = arch_specs();
    let (a, b) = (&specs[3], &specs[9]);
    let base = simulate(a, b, seed(1), 0).state_hash;
    assert_ne!(base, simulate(a, b, seed(2), 0).state_hash);
    assert_ne!(base, simulate(a, b, seed(1), 1).state_hash);
    assert_ne!(base, simulate(b, a, seed(1), 0).state_hash);
}

#[test]
fn state_hash_covers_the_canonical_event_bytes() {
    use sha2::{Digest, Sha256};
    let specs = arch_specs();
    let f = simulate(&specs[0], &specs[1], seed(5), 3);
    let mut bytes = Vec::new();
    for e in &f.events {
        e.encode(&mut bytes);
    }
    let h: [u8; 32] = Sha256::digest(&bytes).into();
    assert_eq!(h, f.state_hash);
    // every event variant encodes to something non-empty with a distinct tag
    let mut tags: Vec<u8> = f.events.iter().map(|e| { let mut o = Vec::new(); e.encode(&mut o); o[0] }).collect();
    tags.sort();
    tags.dedup();
    assert!(tags.len() >= 5);
}

#[test]
fn invariants_hold_over_thousands_of_random_fights() {
    let mut rng = Rng::from_u64(77);
    let (mut max_events, mut draws, mut kos, mut limits, mut three_round) = (0, 0, 0, 0, 0);
    for i in 0..3000 {
        let a = random_spec(&mut rng, i % 2 == 0);
        let b = random_spec(&mut rng, i % 3 == 0);
        let f = simulate(&a, &b, rng.seed32(), (i % 9) as u8); // rule 8 = no modifier
        check_fight(&f);
        max_events = max_events.max(f.events.len());
        draws += (f.winner == Winner::Draw) as u32;
        three_round += (f.rounds.len() == 3) as u32;
        for r in &f.rounds {
            match r.reason {
                bout_sim::events::Reason::Ko => kos += 1,
                bout_sim::events::Reason::Limit => limits += 1,
            }
            assert!(r.exchanges >= 1 && r.exchanges <= MAX_EXCHANGES);
        }
    }
    assert!(max_events <= 200, "max events {max_events}");
    assert!(draws > 0 && kos > 0 && limits > 0 && three_round > 0, "coverage: {draws} {kos} {limits} {three_round}");
}

#[test]
fn draw_semantics() {
    // Mirror fights: find real draws and check every rule of the draw semantics.
    let specs = arch_specs();
    let mut found = 0;
    let mut round_draws_by_margin = 0;
    for i in 0..4000u64 {
        let a = &specs[(i % 40) as usize];
        let f = simulate(a, a, seed(i), (i % 8) as u8);
        if f.winner == Winner::Draw {
            found += 1;
            assert_eq!(f.rounds_won[0], f.rounds_won[1], "draw means equal round wins");
            assert!(f.rounds.len() >= 2);
            match f.events.last().unwrap() {
                Event::MatchEnd { winner, rounds } => assert!(*winner == 2 && rounds[0] == rounds[1]),
                _ => panic!(),
            }
        } else {
            assert_ne!(f.rounds_won[0], f.rounds_won[1]);
            let w = f.rounds_won[0].max(f.rounds_won[1]);
            assert!(w >= 1);
        }
        for (k, r) in f.rounds.iter().enumerate() {
            if r.winner == 2 {
                if r.reason == bout_sim::events::Reason::Limit {
                    let ev = f.events.iter().filter_map(|e| if let Event::MatchStart { max_hp, .. } = e { Some(*max_hp) } else { None }).next().unwrap();
                    let p0 = r.hp[0] as i32 * 1000 / ev[0] as i32;
                    let p1 = r.hp[1] as i32 * 1000 / ev[1] as i32;
                    assert!((p0 - p1).abs() < DRAW_MARGIN_PM, "round {k}: {p0} vs {p1}");
                    round_draws_by_margin += 1;
                } else {
                    assert!(r.hp[0] == 0 && r.hp[1] == 0, "KO draw must be a double knockout");
                }
            }
        }
    }
    assert!(found > 20, "mirror matches should draw sometimes, found {found}");
    assert!(round_draws_by_margin > 0);
}

#[test]
fn a_better_built_fighter_wins_more_often_from_either_seat() {
    let strong = normalize(&raw_with("BLAZE", "BRAWLER", ["inferno", "ember_jab", "flame_lash"], [10, 5, 5, 8])).unwrap();
    let weak = normalize(&raw_with("BLAZE", "SHOWBOAT", ["tidal_wall", "healing_rain", "hex_gaze"], [1, 1, 1, 1])).unwrap();
    let o = odds(&strong, &weak, seed(3), 8, 2000);
    assert!(o.champion > o.challenger + 100, "{o:?}");
    // the reverse seating favours the same fighter (seat bias is small)
    let r = odds(&weak, &strong, seed(3), 8, 2000);
    assert!(r.challenger > r.champion, "{r:?}");
    assert_eq!(o.champion + o.draw + o.challenger, o.n);
}

#[test]
fn stun_lock_is_bounded() {
    let a = normalize(&raw_with("VOLT", "TACTICIAN", ["static_field", "thunderclap", "arc_bolt"], [5, 5, 10, 3])).unwrap();
    let b = normalize(&raw_with("VOLT", "TACTICIAN", ["static_field", "spark", "thunderclap"], [5, 3, 10, 3])).unwrap();
    let (mut skips, mut turns) = ([0u32; 2], [0u32; 2]);
    for i in 0..600u64 {
        let f = simulate(&a, &b, seed(i), (i % 8) as u8);
        let mut last_skip: [Option<(u8, u8)>; 2] = [None, None];
        let (mut round, mut exch) = (0u8, 0u8);
        for e in &f.events {
            match e {
                Event::RoundStart { round: r, .. } => { round = *r; last_skip = [None, None]; }
                Event::Exchange { n, .. } => exch = *n,
                Event::Skip { actor } => {
                    skips[*actor as usize] += 1;
                    turns[*actor as usize] += 1;
                    if let Some((r, x)) = last_skip[*actor as usize] {
                        assert!(r != round || exch >= x + STUN_IMMUNE, "stunned again after {} exchanges", exch - x);
                    }
                    last_skip[*actor as usize] = Some((round, exch));
                }
                Event::Act { actor, .. } => turns[*actor as usize] += 1,
                _ => {}
            }
        }
    }
    for side in 0..2 {
        let share = skips[side] * 100 / turns[side];
        assert!(share <= 34, "side {side} lost {share}% of turns");
    }
}

#[test]
fn rules_change_outcomes_as_documented() {
    let blaze = normalize(&raw_with("BLAZE", "BRAWLER", ["inferno", "flame_lash", "ember_jab"], [6, 5, 5, 6])).unwrap();
    let tide = normalize(&raw_with("TIDE", "BRAWLER", ["riptide", "wave_slap", "undertow"], [6, 5, 5, 6])).unwrap();
    // Furnace Night (0) boosts BLAZE moves: the BLAZE fighter wins more than under Padded Ring (2)
    let hot = odds(&blaze, &tide, seed(9), 0, 400).champion_pct;
    let cold = odds(&blaze, &tide, seed(9), 2, 400).champion_pct;
    assert!(hot > cold, "{hot} vs {cold}");
    // No Medics (3): lifesteal and heals never show up in events
    for i in 0..60u64 {
        let f = simulate(&tide, &tide, seed(i), 3);
        for e in &f.events {
            if let Event::Act { heal, .. } = e {
                assert_eq!(*heal, 0);
            }
        }
    }
    // Rule ids >= 8 are "no modifier" and never panic
    let _ = simulate(&blaze, &tide, seed(1), 8);
    let _ = simulate(&blaze, &tide, seed(1), 255);
}

#[test]
fn event_fields_are_consistent() {
    let mut rng = Rng::from_u64(5);
    let (mut crits, mut misses, mut blocked, mut countered, mut skips, mut burns, mut heals) = (0, 0, 0, 0, 0, 0, 0);
    for i in 0..1500 {
        let a = random_spec(&mut rng, true);
        let b = random_spec(&mut rng, true);
        let f = simulate(&a, &b, rng.seed32(), (i % 8) as u8);
        let Event::MatchStart { max_hp, .. } = f.events[0] else { panic!() };
        let mut prev = max_hp;
        for e in &f.events {
            match *e {
                Event::RoundStart { .. } => prev = max_hp,
                Event::Act { actor, move_id, outcome, hits, dmg, absorbed, heal, recoil, hp, .. } => {
                    let (me, foe) = (actor as usize, 1 - actor as usize);
                    assert_eq!(hp[foe] as i32, prev[foe] as i32 - dmg as i32, "foe HP delta must equal dmg");
                    assert_eq!(hp[me] as i32, prev[me] as i32 - recoil as i32 + heal as i32, "actor HP delta = heal - recoil");
                    assert!(moves::get(move_id).is_some());
                    match outcome {
                        Outcome::Crit => crits += 1,
                        Outcome::Miss => {
                            misses += 1;
                            assert!(dmg == 0 && hits == 0 && absorbed == 0);
                        }
                        Outcome::Blocked => {
                            blocked += 1;
                            assert!(dmg == 0 && absorbed > 0);
                        }
                        Outcome::Countered => countered += 1,
                        _ => {}
                    }
                    if recoil > 0 {
                        assert_eq!(outcome, Outcome::Countered);
                    }
                    if heal > 0 {
                        heals += 1;
                    }
                    prev = hp;
                }
                Event::Skip { .. } => skips += 1,
                Event::Upkeep { burn, side, hp, .. } => {
                    assert_eq!(hp[side as usize] as i32, prev[side as usize] as i32 - burn as i32);
                    if burn > 0 {
                        burns += 1;
                    }
                    prev = hp;
                }
                _ => {}
            }
        }
    }
    assert!(crits > 0 && misses > 0 && blocked > 0 && countered > 0 && skips > 0 && burns > 0 && heals > 0, "{crits} {misses} {blocked} {countered} {skips} {burns} {heals}");
}

#[test]
fn fighter_with_only_cooldown_moves_uses_the_basic_scrap() {
    // two support moves + one strike all on cooldown some exchanges: basic move id 255 must appear
    let a = normalize(&raw_with("IRON", "BRAWLER", ["wrecking_swing", "bulwark", "armor_up"], [5, 5, 5, 5])).unwrap();
    let mut saw_basic = false;
    for i in 0..50u64 {
        let f = simulate(&a, &a, seed(i), 8);
        for e in &f.events {
            if let Event::Act { slot: 3, move_id, .. } = e {
                assert_eq!(*move_id, moves::BASIC_ID);
                saw_basic = true;
            }
        }
    }
    assert!(saw_basic);
    assert!(LIBRARY.len() < 255);
}

#[test]
fn odds_are_deterministic_and_fast_enough() {
    let specs = arch_specs();
    let o1 = odds(&specs[0], &specs[1], seed(1), 0, 200);
    let o2 = odds(&specs[0], &specs[1], seed(1), 0, 200);
    assert_eq!(o1, o2);
    assert_eq!(o1.n, 200);
    assert_eq!(odds(&specs[0], &specs[1], seed(1), 0, 99999).n, 2000);
    assert_eq!(odds(&specs[0], &specs[1], seed(1), 0, 0).n, 1);
    let t = std::time::Instant::now();
    let mut keep = 0;
    for i in 0..10 {
        keep += odds(&specs[i], &specs[i + 10], seed(i as u64), 1, 200).champion;
    }
    let per200 = t.elapsed().as_micros() / 10;
    eprintln!("odds(200) native: {per200} us (sink {keep})");
    assert!(per200 < 50_000, "native odds(200) took {per200} us");
    let _ = random_raw;
}

#[test]
fn matchup_table_matches_the_documented_cycle() {
    use bout_sim::types::{matchup, School::*};
    assert_eq!(matchup(Blaze, Wild), 1);
    assert_eq!(matchup(Blaze, Iron), 1);
    assert_eq!(matchup(Wild, Blaze), -1);
    assert_eq!(matchup(Blaze, Tide), 0);
    assert_eq!(matchup(Tide, Volt), 1);
    assert_eq!(matchup(Volt, Blaze), 1);
}
