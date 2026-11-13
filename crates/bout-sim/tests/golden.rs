mod common;
use bout_sim::rulebook::{from_hex32, hex};
use bout_sim::{normalize, simulate, Raw};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    id: String,
    champion: Raw,
    challenger: Raw,
    seed: String,
    rule: u8,
    winner: String,
    rounds_won: [u8; 2],
    rounds: u8,
    events: usize,
    state_hash: String,
}

fn vectors() -> Vec<Vector> {
    serde_json::from_str(include_str!("../fixtures/golden.json")).expect("golden.json")
}

#[test]
fn golden_fights_replay_to_the_committed_hashes() {
    let v = vectors();
    assert!(v.len() >= 20, "need 20 golden vectors, have {}", v.len());
    for g in &v {
        let c = normalize(&g.champion).unwrap();
        let h = normalize(&g.challenger).unwrap();
        let f = simulate(&c, &h, from_hex32(&g.seed).unwrap(), g.rule);
        assert_eq!(hex(&f.state_hash), g.state_hash, "{}: state hash drifted (re-run `cargo run --release --bin golden` only if the rules changed on purpose)", g.id);
        assert_eq!(serde_json::to_value(f.winner).unwrap(), g.winner, "{}", g.id);
        assert_eq!(f.rounds_won, g.rounds_won, "{}", g.id);
        assert_eq!(f.rounds.len() as u8, g.rounds, "{}", g.id);
        assert_eq!(f.events.len(), g.events, "{}", g.id);
    }
}

#[test]
fn golden_set_covers_the_interesting_cases() {
    let v = vectors();
    let rules: std::collections::BTreeSet<u8> = v.iter().map(|g| g.rule).collect();
    assert_eq!(rules.len(), 8, "all 8 rules");
    assert!(v.iter().any(|g| g.winner == "draw"), "a draw");
    assert!(v.iter().any(|g| g.winner == "champion") && v.iter().any(|g| g.winner == "challenger"));
    assert!(v.iter().any(|g| g.rounds == 2) && v.iter().any(|g| g.rounds == 3));
}
