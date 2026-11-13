//! Operations (wasm only): ping, probe, forge.
use crate::net::{self, Net};
use serde_json::{json, Value};
use std::time::Instant;
use titleshot_forge::compile::compile;
use titleshot_forge::input::{vrf_seed, Failure};
use titleshot_forge::output::{Signed, Vrf};

pub fn draw_vrf(challenge_id: u64) -> Result<Vrf, Failure> {
    let r = outlayer::vrf::random(&vrf_seed(challenge_id)).map_err(|e| Failure::new("E_VRF", e))?;
    Ok(Vrf { output_hex: r.output_hex, signature_hex: r.signature_hex, alpha: r.alpha })
}

pub fn ping() -> Result<Value, Failure> {
    let has_key = std::env::var("NEARAI_API_KEY").map(|k| !k.is_empty()).unwrap_or(false);
    let pubkey = outlayer::vrf::public_key().unwrap_or_default();
    Ok(json!({"pong": true, "version": env!("CARGO_PKG_VERSION"), "has_key": has_key, "vrf_pubkey": pubkey}))
}

pub fn probe(path: &str) -> Result<Value, Failure> {
    let r = net::get_public(path)?;
    let head: String = String::from_utf8_lossy(&r.body).chars().take(120).collect();
    Ok(json!({"status": r.status, "bytes": r.body.len(), "head": head}))
}

pub fn forge_compile(model_id: &str, sentence: &str, start: Instant) -> Result<Signed, Failure> {
    let key = match std::env::var("NEARAI_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => return Err(Failure::new("E_NO_KEY", "NEARAI_API_KEY not set")),
    };
    compile(&Net { start }, &key, model_id, sentence)
}
