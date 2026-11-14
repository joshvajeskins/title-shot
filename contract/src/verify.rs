//! Pure verification helpers (no contract state). Everything the contract trusts is rebuilt here
//! from inputs it already holds: the request bytes come from fixed prefix/suffix + the escaped
//! sentence, never from the caller.
use near_sdk::{env, serde_json};

pub const MAX_RESPONSE_BYTES: usize = 8 * 1024;
pub const MAX_SENTENCE_BYTES: usize = 1024;

/// Stable error codes (part of the contract's public interface).
pub mod code {
    pub const OK: &str = "OK";
    pub const ALGO: &str = "E_ALGO"; // only "ecdsa" is supported
    pub const KIND: &str = "E_KIND"; // signature_kind must be provider_tee | gateway
    pub const SENTENCE_SIZE: &str = "E_SENTENCE_SIZE";
    pub const RESPONSE_SIZE: &str = "E_RESPONSE_SIZE";
    pub const SIG_HEX: &str = "E_SIG_HEX";
    pub const SIG_LEN: &str = "E_SIG_LEN"; // must be exactly 65 bytes
    pub const SIG_V: &str = "E_SIG_V"; // v must be 0,1,27,28
    pub const RECOVER: &str = "E_RECOVER"; // ecrecover failed (invalid or high-s malleable)
    pub const SIGNER: &str = "E_SIGNER"; // recovered address is not allowlisted
    pub const ENVELOPE: &str = "E_ENVELOPE"; // response is not a chat-completion JSON envelope
    pub const NO_CONTENT: &str = "E_NO_CONTENT"; // choices[0].message.content missing / null
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    ProviderTee,
    Gateway,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "provider_tee" => Some(Kind::ProviderTee),
            "gateway" => Some(Kind::Gateway),
            _ => None,
        }
    }
}

/// `serde_json::to_string(s)` without the outer quotes.
pub fn json_escape(s: &str) -> String {
    let q = serde_json::to_string(s).unwrap_or_default();
    q[1..q.len() - 1].to_string()
}

pub fn request_bytes(prefix: &[u8], suffix: &[u8], sentence: &str) -> Vec<u8> {
    let esc = json_escape(sentence);
    let mut v = Vec::with_capacity(prefix.len() + esc.len() + suffix.len());
    v.extend_from_slice(prefix);
    v.extend_from_slice(esc.as_bytes());
    v.extend_from_slice(suffix);
    v
}

/// The exact UTF-8 text NEAR AI signs.
///  provider_tee: "{model_id}:{hex sha256 req}:{hex sha256 resp}"
///  gateway:      "{hex sha256 req}:{hex sha256 resp}"
pub fn signed_text(kind: Kind, model_id: &str, req_hash: &[u8; 32], resp_hash: &[u8; 32]) -> String {
    let (rq, rs) = (crate::hex::encode(req_hash), crate::hex::encode(resp_hash));
    match kind {
        Kind::ProviderTee => format!("{model_id}:{rq}:{rs}"),
        Kind::Gateway => format!("{rq}:{rs}"),
    }
}

/// keccak256("\x19Ethereum Signed Message:\n" ++ decimal len ++ text)
pub fn eip191_digest(text: &str) -> [u8; 32] {
    let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    m.extend_from_slice(text.as_bytes());
    env::keccak256_array(&m)
}

/// 65-byte r||s||v signature (optional 0x prefix) -> (r||s, recovery id 0/1).
pub fn decode_sig(sig_hex: &str) -> Result<([u8; 64], u8), &'static str> {
    let h = sig_hex.strip_prefix("0x").unwrap_or(sig_hex);
    let raw = crate::hex::decode(h).map_err(|_| code::SIG_HEX)?;
    if raw.len() != 65 {
        return Err(code::SIG_LEN);
    }
    let v = match raw[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        _ => return Err(code::SIG_V),
    };
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&raw[..64]);
    Ok((rs, v))
}

/// 64-byte uncompressed secp256k1 pubkey -> 20-byte Ethereum address.
pub fn address_of(pubkey: &[u8; 64]) -> [u8; 20] {
    let h = env::keccak256_array(pubkey);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}

pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    if h.len() != 40 {
        return None;
    }
    let mut a = [0u8; 20];
    crate::hex::decode_to_slice(h, &mut a).ok()?;
    Some(a)
}

pub fn addr_hex(a: &[u8; 20]) -> String {
    format!("0x{}", crate::hex::encode(a))
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope {
    choices: Vec<Choice>,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Choice {
    message: Message,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Message {
    content: Option<String>,
}

/// choices[0].message.content of an OpenAI-style chat completion.
pub fn extract_content(response: &str) -> Result<String, &'static str> {
    let env: Envelope = serde_json::from_str(response).map_err(|_| code::ENVELOPE)?;
    let first = env.choices.into_iter().next().ok_or(code::ENVELOPE)?;
    first.message.content.filter(|c| !c.is_empty()).ok_or(code::NO_CONTENT)
}

/// Everything a signature check needs from the contract config.
pub struct Ctx<'a> {
    pub prefix: &'a [u8],
    pub suffix: &'a [u8],
    pub model_id: &'a str,
    pub kind: Kind,
    pub allowlist: &'a [[u8; 20]],
}

/// What a verified compile yields.
pub struct Verified {
    pub signer: [u8; 20],
    pub content: String,
}

/// Check order and semantics are identical to the spike's `verify_forge` (algo, kind, caps, sig
/// shape, rebuilt request, EIP-191, ecrecover with malleability check, allowlist), then the
/// attested bytes are parsed. `Err` carries the spike's stable code (`E_SIGNER`, `E_RECOVER`, ...).
pub fn verify_ai(
    ctx: &Ctx,
    sentence: &str,
    response: &str,
    sig_hex: &str,
    algo: &str,
    kind: &str,
) -> Result<Verified, &'static str> {
    if algo != "ecdsa" {
        return Err(code::ALGO);
    }
    if Kind::parse(kind) != Some(ctx.kind) {
        return Err(code::KIND);
    }
    if sentence.len() > MAX_SENTENCE_BYTES {
        return Err(code::SENTENCE_SIZE);
    }
    if response.len() > MAX_RESPONSE_BYTES {
        return Err(code::RESPONSE_SIZE);
    }
    let (rs, v) = decode_sig(sig_hex)?;
    let req = request_bytes(ctx.prefix, ctx.suffix, sentence);
    let req_hash = env::sha256_array(&req);
    let resp_hash = env::sha256_array(response.as_bytes());
    let digest = eip191_digest(&signed_text(ctx.kind, ctx.model_id, &req_hash, &resp_hash));
    let pubkey = env::ecrecover(&digest, &rs, v, true).ok_or(code::RECOVER)?;
    let signer = address_of(&pubkey);
    if !ctx.allowlist.contains(&signer) {
        return Err(code::SIGNER);
    }
    Ok(Verified { signer, content: extract_content(response)? })
}

/// Signature-stage codes all surface as `E_AI_SIG`; envelope problems keep their own code.
pub fn is_signature_failure(c: &str) -> bool {
    !matches!(c, code::ENVELOPE | code::NO_CONTENT)
}
