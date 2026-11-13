//! Compact output JSON and the NEAR AI signed-text rule.
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Vrf {
    pub output_hex: String,
    pub signature_hex: String,
    pub alpha: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Signed {
    pub response: String,
    pub signature: String,
    pub signing_address: String,
    pub signing_algo: String,
    pub signature_kind: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
struct OkOut {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signing_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signing_algo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vrf: Option<Vrf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<serde_json::Value>,
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// provider_tee: `{model}:{sha256(req)}:{sha256(resp)}`; gateway: `{sha256(req)}:{sha256(resp)}`.
pub fn expected_text(kind: &str, model: &str, req: &[u8], resp: &[u8]) -> Option<String> {
    let h = format!("{}:{}", sha256_hex(req), sha256_hex(resp));
    match kind {
        "provider_tee" => Some(format!("{model}:{h}")),
        "gateway" => Some(h),
        _ => None,
    }
}

pub fn ok_json(signed: Option<Signed>, vrf: Option<Vrf>, info: Option<serde_json::Value>) -> String {
    let (response, signature, signing_address, signing_algo, signature_kind, text) = match signed {
        Some(s) => (
            Some(s.response),
            Some(s.signature),
            Some(s.signing_address),
            Some(s.signing_algo),
            Some(s.signature_kind),
            Some(s.text),
        ),
        None => (None, None, None, None, None, None),
    };
    let out = OkOut {
        ok: true,
        response,
        signature,
        signing_address,
        signing_algo,
        signature_kind,
        text,
        vrf,
        info,
    };
    serde_json::to_string(&out).unwrap_or_else(|_| fail_json("E_ENCODE", ""))
}

pub fn fail_json(code: &str, detail: &str) -> String {
    let d: String = detail.chars().take(200).collect();
    serde_json::json!({"ok": false, "code": code, "detail": d}).to_string()
}
