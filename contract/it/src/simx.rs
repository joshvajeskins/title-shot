//! Native replica of the contract's seed + bout derivation, used to *choose* VRF outputs that produce a
//! wanted result (win, lose, draw) and to predict what the contract must store. The seed rule is the one in
//! docs/CONTRACT.md: seed = sha256("titleshot:seed:" ++ vrf_output ++ challenge_id_le); a sealed rule is
//! `seed[0] % 8` at the first bout of a season.
use bout_sim::types::Winner;
use bout_sim::Spec;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn seed(vrf: &[u8; 32], challenge_id: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"titleshot:seed:");
    h.update(vrf);
    h.update(challenge_id.to_le_bytes());
    h.finalize().into()
}

pub fn vrf_from(counter: u64) -> [u8; 32] {
    Sha256::digest(format!("test-vrf-{counter}").as_bytes()).into()
}

pub fn spec(raw: &Value) -> Spec {
    bout_sim::normalize_str(&raw.to_string()).unwrap_or_else(|e| panic!("fixture does not normalize: {e}"))
}

pub fn sentence_hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Predicted outcome. `rule`: the season's fixed rule, or `None` while it is still sealed (derived from the seed).
pub fn outcome(champ: &Spec, chall: &Spec, vrf: &[u8; 32], id: u64, rule: Option<u8>) -> (Winner, [u8; 32], u8) {
    let sd = seed(vrf, id);
    let rule = rule.unwrap_or(sd[0] % 8);
    let (w, state_hash) = bout_sim::simulate_lite(champ, chall, sd, rule);
    (w, state_hash, rule)
}

pub fn winner_name(w: Winner) -> &'static str {
    match w {
        Winner::Champion => "champion",
        Winner::Challenger => "challenger",
        Winner::Draw => "draw",
    }
}

/// First VRF output (searching deterministically) whose bout ends as `want`.
pub fn find_vrf(champ: &Spec, chall: &Spec, id: u64, rule: Option<u8>, want: Winner) -> [u8; 32] {
    for c in 0..20_000u64 {
        let vrf = vrf_from(c);
        if outcome(champ, chall, &vrf, id, rule).0 == want {
            return vrf;
        }
    }
    panic!("no VRF output gives {want:?} for these fighters (rule {rule:?}); pick other fixtures");
}

/// All archetype fixtures from the sim lane: (sentence, raw model JSON).
pub fn archetypes() -> Vec<(String, Value)> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/bout-sim/fixtures/archetypes.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).expect("archetypes.json")).unwrap();
    v.as_array().unwrap().iter().map(|e| (e["sentence"].as_str().unwrap().to_string(), e["raw"].clone())).collect()
}

pub fn archetype(name_part: &str) -> (String, Value) {
    archetypes().into_iter().find(|(s, _)| s.contains(name_part)).unwrap_or_else(|| panic!("no archetype containing {name_part}"))
}
