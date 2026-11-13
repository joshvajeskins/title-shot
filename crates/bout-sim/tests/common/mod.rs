#![allow(dead_code)]
use bout_sim::rng::Rng;
use bout_sim::spec::{Raw, Spec};
use bout_sim::tune::{FORM_MIN, FORM_SPAN};
use bout_sim::{normalize, Fight};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Arch {
    pub sentence: String,
    pub raw: Raw,
}

pub fn archetypes() -> Vec<Arch> {
    serde_json::from_str(include_str!("../../fixtures/archetypes.json")).expect("archetypes.json parses")
}

pub fn arch_specs() -> Vec<Spec> {
    archetypes().iter().map(|a| normalize(&a.raw).expect("archetype normalizes")).collect()
}

pub fn seed(i: u64) -> [u8; 32] {
    Rng::from_u64(i.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xABCD).seed32()
}

pub fn base_raw() -> Raw {
    archetypes().remove(0).raw
}

/// Check every structural invariant of an event log.
pub fn check_fight(f: &Fight) {
    use bout_sim::events::Event::*;
    let e = &f.events;
    assert!(matches!(e.first(), Some(MatchStart { .. })));
    assert!(matches!(e.last(), Some(MatchEnd { .. })));
    assert!(e.len() <= 200, "events {}", e.len());
    let MatchStart { max_hp, .. } = e[0] else { unreachable!() };
    let (mut round, mut in_round, mut exch, mut rounds_ended) = (0u8, false, 0u8, 0usize);
    let mut won = [0u8; 2];
    for ev in e {
        match ev {
            RoundStart { round: r, form } => {
                assert!(!in_round);
                round += 1;
                assert_eq!(*r, round);
                assert!(form.iter().all(|&x| (FORM_MIN as u8..=(FORM_MIN + FORM_SPAN - 1) as u8).contains(&x)));
                in_round = true;
                exch = 0;
            }
            Exchange { round: r, n, first } => {
                assert!(in_round && *r == round && *first < 2);
                assert_eq!(*n, exch + 1);
                assert!(*n <= 10);
                exch = *n;
            }
            Act { actor, slot, hp, shield, dmg, .. } => {
                assert!(in_round && exch > 0 && *actor < 2 && *slot <= 3);
                assert!(hp[0] <= max_hp[0] && hp[1] <= max_hp[1]);
                assert!(shield[0] < 5000 && shield[1] < 5000);
                assert!(*dmg <= max_hp[1 - *actor as usize]);
            }
            Skip { actor } => assert!(in_round && *actor < 2),
            Upkeep { side, hp, .. } => assert!(in_round && *side < 2 && hp[0] <= max_hp[0]),
            RoundEnd { round: r, winner, hp, .. } => {
                assert!(in_round && *r == round && *winner <= 2);
                if *winner < 2 {
                    won[*winner as usize] += 1;
                }
                let _ = hp;
                in_round = false;
                rounds_ended += 1;
            }
            MatchEnd { winner, rounds } => {
                assert!(!in_round);
                assert_eq!(*rounds, won);
                assert_eq!(*winner, f.winner.code());
            }
            MatchStart { .. } => {}
        }
    }
    assert_eq!(rounds_ended, f.rounds.len());
    assert!((2..=3).contains(&rounds_ended) || (won[0] < 2 && won[1] < 2 && rounds_ended == 3));
    assert_eq!(f.rounds_won, won);
    assert!(won[0] >= 2 || won[1] >= 2 || rounds_ended == 3);
}
