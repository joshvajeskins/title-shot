//! The forge-output parser. Kept in one module so the OutLayer/forge shape can be adjusted in one place.
//!
//! Shape (see forge/src/output.rs; extra fields are tolerated):
//! `{ok:true, response, signature, signing_algo, signature_kind, signing_address, text?,
//!   vrf:{output_hex, signature_hex?, alpha?}, info?}` or `{ok:false, code, detail}`.
//! OutLayer may hand the object over directly or as a JSON string; both are accepted.
use crate::codes::{E_FORGE_FAILED, E_FORGE_OUTPUT};
use near_sdk::serde_json::{self, Value};

/// Largest forge output the callback will look at (the AI response itself is capped at 8 KB).
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ai {
    pub response: String,
    pub signature: String,
    pub algo: String,
    /// `None` when the forge did not say; the contract then assumes its configured kind.
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VrfOut {
    pub output: [u8; 32],
    pub alpha: Option<String>,
    pub signature: Option<[u8; 64]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeOutput {
    pub ai: Option<Ai>,
    pub vrf: Option<VrfOut>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub code: &'static str,
    pub detail: String,
}

fn err(code: &'static str, detail: impl Into<String>) -> ParseError {
    ParseError { code, detail: detail.into() }
}

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn hex_fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let mut out = [0u8; N];
    hex::decode_to_slice(s, &mut out).ok()?;
    Some(out)
}

/// Raw promise bytes -> output. Never panics.
pub fn parse_bytes(bytes: &[u8]) -> Result<ForgeOutput, ParseError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(err(E_FORGE_OUTPUT, "output too large"));
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| err(E_FORGE_OUTPUT, "not json"))?;
    parse_value(&v)
}

pub fn parse_str(s: &str) -> Result<ForgeOutput, ParseError> {
    parse_bytes(s.as_bytes())
}

pub fn parse_value(v: &Value) -> Result<ForgeOutput, ParseError> {
    // A JSON string holding the object (some OutLayer paths double-encode).
    if let Some(inner) = v.as_str() {
        return parse_str(inner);
    }
    if v.is_null() {
        return Err(err(E_FORGE_FAILED, "null result"));
    }
    if !v.is_object() {
        return Err(err(E_FORGE_OUTPUT, "not an object"));
    }
    match v.get("ok").and_then(Value::as_bool) {
        Some(true) => {}
        Some(false) => {
            let c = text(v, "code").unwrap_or_default();
            return Err(err(E_FORGE_FAILED, c.chars().take(64).collect::<String>()));
        }
        None => return Err(err(E_FORGE_OUTPUT, "missing ok")),
    }
    let ai = match (text(v, "response"), text(v, "signature")) {
        (Some(response), Some(signature)) => Some(Ai {
            response,
            signature,
            algo: text(v, "signing_algo").unwrap_or_default(),
            kind: text(v, "signature_kind"),
        }),
        _ => None,
    };
    let vrf = match v.get("vrf") {
        Some(o) if o.is_object() => {
            let output = text(o, "output_hex").and_then(|h| hex_fixed::<32>(&h));
            output.map(|output| VrfOut {
                output,
                alpha: text(o, "alpha"),
                signature: text(o, "signature_hex").and_then(|h| hex_fixed::<64>(&h)),
            })
        }
        _ => None,
    };
    Ok(ForgeOutput { ai, vrf })
}
