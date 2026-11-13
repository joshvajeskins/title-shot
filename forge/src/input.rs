//! Input parsing and validation. Fails closed with stable codes.
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Input {
    Ping,
    Probe {
        /// Allowlisted public GET path on cloud-api.near.ai.
        path: String,
    },
    Forge {
        #[serde(default)]
        sentence: String,
        #[serde(default)]
        need_compile: bool,
        challenge_id: u64,
        #[serde(default)]
        model_id: String,
    },
}

#[derive(Debug, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub detail: String,
}

impl Failure {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Failure { code, detail: detail.into() }
    }
}

pub fn parse(raw: &str) -> Result<Input, Failure> {
    let input: Input =
        serde_json::from_str(raw).map_err(|e| Failure::new("E_BAD_INPUT", e.to_string()))?;
    if let Input::Forge { sentence, need_compile, model_id, .. } = &input {
        if *need_compile {
            // One rule everywhere: bout-sim's check (3..=120 chars, no control/bidi/invisible).
            bout_sim::spec::check_sentence(sentence)
                .map_err(|r| Failure::new("E_SENTENCE", r.code()))?;
            if model_id.is_empty() || model_id.len() > 80 {
                return Err(Failure::new("E_MODEL_ID", "model_id missing or too long"));
            }
        }
    }
    if let Input::Probe { path } = &input {
        if !probe_path_ok(path) {
            return Err(Failure::new("E_PROBE_PATH", path.clone()));
        }
    }
    Ok(input)
}

/// Only fixed public read endpoints; no query strings, no traversal.
pub fn probe_path_ok(path: &str) -> bool {
    matches!(path, "/v1/models" | "/v1/attestation/report")
}

/// VRF user seed. OutLayer forbids ':' in the seed (':' delimits alpha), so the colon form
/// `titleshot:challenge:{id}` from the brief cannot be used; this is the dash form.
pub fn vrf_seed(challenge_id: u64) -> String {
    format!("titleshot-challenge-{challenge_id}")
}
