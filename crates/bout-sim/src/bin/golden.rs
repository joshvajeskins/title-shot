//! Regenerates fixtures/golden.json (20 vectors built from the archetype fixtures).
//! Run ONLY when the rules changed on purpose: `cargo run --release --bin golden`.

use bout_sim::rng::Rng;
use bout_sim::rulebook::hex;
use bout_sim::spec::Raw;
use bout_sim::{normalize, simulate, Fight};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Arch {
    raw: Raw,
}

#[derive(Serialize)]
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

fn pick(arch: &[Arch], i: u64) -> (usize, usize, [u8; 32], u8) {
    let n = arch.len() as u64;
    let a = (i * 7 + 1) % n;
    let mut b = (i * 11 + 3) % n;
    if a == b {
        b = (b + 1) % n;
    }
    (a as usize, b as usize, Rng::from_u64(0x601D + i * 977).seed32(), (i % 8) as u8)
}

fn run(arch: &[Arch], a: usize, b: usize, seed: [u8; 32], rule: u8) -> Fight {
    let c = normalize(&arch[a].raw).expect("archetype");
    let h = normalize(&arch[b].raw).expect("archetype");
    simulate(&c, &h, seed, rule)
}

fn main() {
    let arch: Vec<Arch> = serde_json::from_str(include_str!("../../fixtures/archetypes.json")).expect("archetypes");
    let mut out: Vec<Vector> = Vec::new();
    let mut add = |id: String, a: usize, b: usize, seed: [u8; 32], rule: u8, f: &Fight| {
        out.push(Vector {
            id,
            champion: arch[a].raw.clone(),
            challenger: arch[b].raw.clone(),
            seed: hex(&seed),
            rule,
            winner: serde_json::to_value(f.winner).unwrap().as_str().unwrap().to_string(),
            rounds_won: f.rounds_won,
            rounds: f.rounds.len() as u8,
            events: f.events.len(),
            state_hash: hex(&f.state_hash),
        });
    };
    for i in 0..16u64 {
        let (a, b, seed, rule) = pick(&arch, i);
        let f = run(&arch, a, b, seed, rule);
        add(format!("seq-{:02}", i), a, b, seed, rule, &f);
    }
    // targeted vectors: a draw, a three-round decision, a limit-ended round, a double-rule check
    type Pred = fn(&Fight) -> bool;
    let targets: [(&str, Pred); 4] = [
        ("draw", |f| f.winner == bout_sim::types::Winner::Draw),
        ("three-rounds-decided", |f| f.rounds.len() == 3 && f.winner != bout_sim::types::Winner::Draw),
        ("limit-round", |f| f.rounds.iter().any(|r| r.reason == bout_sim::events::Reason::Limit && r.winner != 2)),
        ("sweep-2-0", |f| f.rounds.len() == 2 && f.rounds_won.contains(&2)),
    ];
    for (k, (name, pred)) in targets.iter().enumerate() {
        let mut j = 1000 + k as u64 * 100_000;
        loop {
            let (a, b, seed, rule) = pick(&arch, j);
            let rule = ((rule as u64 + k as u64 * 3) % 8) as u8;
            let f = run(&arch, a, b, seed, rule);
            if pred(&f) {
                add(format!("target-{}", name), a, b, seed, rule, &f);
                break;
            }
            j += 1;
        }
    }
    std::fs::write("fixtures/golden.json", serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    println!("wrote {} golden vectors", out.len());
}
