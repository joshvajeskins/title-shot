//! wasm-bindgen JSON exports for the browser. Every function takes and returns JSON strings.
use crate::{odds, rulebook, sim, spec::Spec, Raw};
use wasm_bindgen::prelude::*;

fn err(code: &str) -> String {
    format!("{{\"ok\":false,\"error\":{{\"code\":\"{}\"}}}}", code)
}

fn parse_spec(j: &str) -> Result<Spec, String> {
    Spec::from_json(j).map_err(|e| serde_json::to_string(&serde_json::json!({"ok": false, "error": e})).unwrap_or_default())
}

/// Raw model JSON -> `{ok:true, spec}` or `{ok:false, error:{code, field}}`.
#[wasm_bindgen]
pub fn normalize(raw_json: &str) -> String {
    let raw: Raw = match serde_json::from_str(raw_json) {
        Ok(r) => r,
        Err(_) => return err("E_BAD_JSON"),
    };
    match crate::normalize(&raw) {
        Ok(spec) => serde_json::to_string(&serde_json::json!({"ok": true, "spec": spec})).unwrap_or_default(),
        Err(e) => serde_json::to_string(&serde_json::json!({"ok": false, "error": e})).unwrap_or_default(),
    }
}

/// Spec JSONs + 64-hex seed + rule -> `{ok, fight:{rounds, events, winner, rounds_won, state_hash}}`.
#[wasm_bindgen]
pub fn simulate(champ_json: &str, chall_json: &str, seed_hex: &str, rule: u8) -> String {
    let (c, h) = match (parse_spec(champ_json), parse_spec(chall_json)) {
        (Ok(c), Ok(h)) => (c, h),
        (Err(e), _) | (_, Err(e)) => return e,
    };
    let Some(seed) = rulebook::from_hex32(seed_hex) else { return err("E_BAD_SEED") };
    let f = sim::simulate(&c, &h, seed, rule);
    let v = serde_json::json!({"ok": true, "fight": {
        "rounds": f.rounds, "events": f.events, "winner": f.winner, "rounds_won": f.rounds_won,
        "state_hash": rulebook::hex(&f.state_hash)}});
    serde_json::to_string(&v).unwrap_or_default()
}

/// Odds over `n` derived seeds -> `{ok, odds}`.
#[wasm_bindgen]
pub fn odds(champ_json: &str, chall_json: &str, seed_hex: &str, rule: u8, n: u32) -> String {
    let (c, h) = match (parse_spec(champ_json), parse_spec(chall_json)) {
        (Ok(c), Ok(h)) => (c, h),
        (Err(e), _) | (_, Err(e)) => return e,
    };
    let Some(seed) = rulebook::from_hex32(seed_hex) else { return err("E_BAD_SEED") };
    let o = odds::odds(&c, &h, seed, rule, n);
    serde_json::to_string(&serde_json::json!({"ok": true, "odds": o})).unwrap_or_default()
}

/// Library, rules, schools, styles, limits, version and hash for the UI.
#[wasm_bindgen]
pub fn rulebook_json() -> String {
    serde_json::to_string(&rulebook::rulebook_value()).unwrap_or_default()
}

/// `{prefix, suffix}` strings: body = prefix + json_escape(sentence) + suffix.
#[wasm_bindgen]
pub fn request_parts(model_id: &str) -> String {
    let (p, s) = rulebook::request_parts(model_id);
    let v = serde_json::json!({
        "prefix": String::from_utf8_lossy(&p),
        "suffix": String::from_utf8_lossy(&s),
        "rulebook_hash": rulebook::hex(&rulebook::rulebook_hash()),
    });
    serde_json::to_string(&v).unwrap_or_default()
}

/// Full request body for a sentence (the free preview uses the same bytes as the paid forge).
#[wasm_bindgen]
pub fn build_request(model_id: &str, sentence: &str) -> String {
    String::from_utf8(rulebook::build_request(model_id, sentence)).unwrap_or_default()
}

/// Sentence validity check shared with the contract: `{ok}` or `{ok:false, error}`.
#[wasm_bindgen]
pub fn check_sentence(sentence: &str) -> String {
    match crate::spec::check_sentence(sentence) {
        Ok(()) => "{\"ok\":true}".into(),
        Err(e) => serde_json::to_string(&serde_json::json!({"ok": false, "error": e})).unwrap_or_default(),
    }
}
