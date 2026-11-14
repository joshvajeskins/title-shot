//! The forge-output parser. Kept in one module so the OutLayer/forge shape can be adjusted in one place.
//!
//! Shape (see forge/src/output.rs; extra fields are tolerated):
//! `{ok:true, response, signature, signing_algo, signature_kind, signing_address, text?,
//!   vrf:{output_hex, signature_hex?, alpha?}, info?}` or `{ok:false, code, detail}`.
//! OutLayer hands the object over as the callback's promise result: its JSON bytes as stored, whatever their size
//! (see contract/README.md "Large outputs"). `response_format: "Json"` is what the contract requests, so there is no
//! string-wrapped variant to unwrap.
use crate::codes::{E_FORGE_FAILED, E_FORGE_OUTPUT};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json;

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

fn hex_fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let mut out = [0u8; N];
    crate::hex::decode_to_slice(s, &mut out).ok()?;
    Some(out)
}

/// The wire shape. Unknown fields are ignored; a field of the wrong type fails the parse (`E_FORGE_OUTPUT`).
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Wire {
    ok: Option<bool>,
    code: Option<String>,
    response: Option<String>,
    signature: Option<String>,
    signing_algo: Option<String>,
    signature_kind: Option<String>,
    vrf: Option<WireVrf>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct WireVrf {
    output_hex: Option<String>,
    alpha: Option<String>,
    signature_hex: Option<String>,
}

/// Raw promise bytes -> output. Never panics.
pub fn parse_bytes(bytes: &[u8]) -> Result<ForgeOutput, ParseError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(err(E_FORGE_OUTPUT, "output too large"));
    }
    match bytes.iter().copied().find(|b| !b.is_ascii_whitespace()) {
        Some(b'n') if bytes.trim_ascii() == b"null" => Err(err(E_FORGE_FAILED, "null result")),
        Some(b'{') => parse_wire(serde_json::from_slice(bytes).map_err(|_| err(E_FORGE_OUTPUT, "not json"))?),
        Some(_) => Err(err(E_FORGE_OUTPUT, "not an object")),
        None => Err(err(E_FORGE_OUTPUT, "not json")),
    }
}

pub fn parse_str(s: &str) -> Result<ForgeOutput, ParseError> {
    parse_bytes(s.as_bytes())
}

fn parse_wire(w: Wire) -> Result<ForgeOutput, ParseError> {
    match w.ok {
        Some(true) => {}
        Some(false) => return Err(err(E_FORGE_FAILED, w.code.unwrap_or_default().chars().take(64).collect::<String>())),
        None => return Err(err(E_FORGE_OUTPUT, "missing ok")),
    }
    let ai = match (w.response, w.signature) {
        (Some(response), Some(signature)) => Some(Ai { response, signature, algo: w.signing_algo.unwrap_or_default(), kind: w.signature_kind }),
        _ => None,
    };
    let vrf = w.vrf.and_then(|v| {
        let output = v.output_hex.and_then(|h| hex_fixed::<32>(&h))?;
        Some(VrfOut { output, alpha: v.alpha, signature: v.signature_hex.and_then(|h| hex_fixed::<64>(&h)) })
    });
    Ok(ForgeOutput { ai, vrf })
}
