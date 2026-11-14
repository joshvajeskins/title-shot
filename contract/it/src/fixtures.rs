//! NEAR-AI-style signed forge outputs from local test keys (never a real key), plus hostile variants.
//! Request bytes come from `bout_sim::rulebook` (the same source the contract's prefix/suffix come from),
//! the signed text and EIP-191 digest follow spikes/ecrecover/RESULT.md (provider_tee | gateway).
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use k256::ecdsa::SigningKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

pub const MODEL: &str = "Qwen/Qwen3.8-27B";

pub fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}
pub fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}
pub fn key(label: &str) -> SigningKey {
    SigningKey::from_bytes((&Sha256::digest(format!("titleshot-it-key:{label}").as_bytes())).into()).expect("valid scalar")
}
pub fn address(k: &SigningKey) -> String {
    let pt = k.verifying_key().to_encoded_point(false);
    format!("0x{}", hex::encode(&keccak(&pt.as_bytes()[1..])[12..]))
}
/// r || s || v (v = 27/28), EIP-191 personal_sign of `text`.
pub fn eip191_sign(k: &SigningKey, text: &str) -> Vec<u8> {
    let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    m.extend_from_slice(text.as_bytes());
    let (sig, rec) = k.sign_prehash_recoverable(&keccak(&m)).expect("sign");
    let mut o = sig.to_bytes().to_vec();
    o.push(27 + rec.to_byte());
    o
}

#[derive(Clone)]
pub struct Ai {
    pub signer: SigningKey,
    pub stranger: SigningKey,
    pub model: String,
    /// "provider_tee" | "gateway"
    pub kind: String,
}

impl Ai {
    pub fn new(kind: &str) -> Self {
        Self { signer: key("near-ai-signer"), stranger: key("not-allowlisted"), model: MODEL.into(), kind: kind.into() }
    }
    pub fn allowlist(&self) -> Vec<String> {
        vec![address(&self.signer)]
    }
    pub fn parts_b64(&self) -> (String, String) {
        let (p, s) = bout_sim::rulebook::request_parts(&self.model);
        (B64.encode(p), B64.encode(s))
    }
    pub fn request(&self, sentence: &str) -> Vec<u8> {
        bout_sim::rulebook::build_request(&self.model, sentence)
    }
    pub fn envelope(&self, content: &str) -> String {
        serde_json::to_string(&json!({"id":"chatcmpl-it-0001","object":"chat.completion","created":1794500000,"model":self.model,
            "choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":1500,"completion_tokens":120,"total_tokens":1620}}))
        .unwrap()
    }
    /// Like `good`, but the (signed) chat-completion envelope carries `pad` extra bytes (an unknown `system_fingerprint`
    /// field, which the contract ignores): a forge output of any wanted size, still honestly signed.
    pub fn good_padded(&self, sentence: &str, raw: &Value, vrf: &[u8; 32], pad: usize) -> Value {
        let mut env: Value = serde_json::from_str(&self.envelope(&raw.to_string())).unwrap();
        env["system_fingerprint"] = json!("f".repeat(pad));
        let response = serde_json::to_string(&env).unwrap();
        let sig = self.sign_with(&self.signer, sentence, &response);
        self.output_for(&response, &sig, vrf)
    }
    pub fn text(&self, kind: &str, request: &[u8], response: &str) -> String {
        let (rq, rs) = (sha_hex(request), sha_hex(response.as_bytes()));
        if kind == "gateway" {
            format!("{rq}:{rs}")
        } else {
            format!("{}:{rq}:{rs}", self.model)
        }
    }
    pub fn sign_with(&self, k: &SigningKey, sentence: &str, response: &str) -> String {
        format!("0x{}", hex::encode(eip191_sign(k, &self.text(&self.kind, &self.request(sentence), response))))
    }
    /// A forge output exactly as the forge app prints it (and OutLayer hands to the callback).
    pub fn output_for(&self, response: &str, signature: &str, vrf: &[u8; 32]) -> Value {
        json!({"ok":true,"response":response,"signature":signature,"signing_algo":"ecdsa","signature_kind":self.kind,
               "signing_address":address(&self.signer),
               "vrf":crate::simx::vrf_json(vrf)})
    }
    /// Honest compile of `raw` for `sentence`.
    pub fn good(&self, sentence: &str, raw: &Value, vrf: &[u8; 32]) -> Value {
        let response = self.envelope(&raw.to_string());
        let sig = self.sign_with(&self.signer, sentence, &response);
        self.output_for(&response, &sig, vrf)
    }
    /// Output without a compile (the fighter is already stored): VRF only.
    pub fn vrf_only(&self, vrf: &[u8; 32]) -> Value {
        json!({"ok":true,"vrf":crate::simx::vrf_json(vrf)})
    }
}

/// Hostile variants of an honest output. Every one must end `Rejected`/`Refunded`, never a fight.
pub struct Hostile;

impl Hostile {
    /// Response edited after signing (one letter of the fighter's name).
    pub fn tampered_response(ai: &Ai, sentence: &str, raw: &Value, vrf: &[u8; 32]) -> Value {
        let response = ai.envelope(&raw.to_string());
        let sig = ai.sign_with(&ai.signer, sentence, &response);
        let name = raw["name"].as_str().unwrap();
        let altered = response.replacen(name, &format!("{}X", &name[..name.len() - 1]), 1);
        assert_ne!(altered, response);
        ai.output_for(&altered, &sig, vrf)
    }
    /// A valid signature by a key that is not on the allowlist.
    pub fn unlisted_signer(ai: &Ai, sentence: &str, raw: &Value, vrf: &[u8; 32]) -> Value {
        let response = ai.envelope(&raw.to_string());
        let sig = ai.sign_with(&ai.stranger, sentence, &response);
        ai.output_for(&response, &sig, vrf)
    }
    /// Replay: a signature that was valid for another sentence's request.
    pub fn replayed_for_other_sentence(ai: &Ai, other: &str, raw: &Value, vrf: &[u8; 32]) -> Value {
        let response = ai.envelope(&raw.to_string());
        let sig = ai.sign_with(&ai.signer, other, &response);
        ai.output_for(&response, &sig, vrf)
    }
    /// Signature kind mismatch: the honest signer signed the *other* kind's text.
    pub fn wrong_kind_text(ai: &Ai, sentence: &str, raw: &Value, vrf: &[u8; 32]) -> Value {
        let response = ai.envelope(&raw.to_string());
        let other = if ai.kind == "gateway" { "provider_tee" } else { "gateway" };
        let sig = format!("0x{}", hex::encode(eip191_sign(&ai.signer, &ai.text(other, &ai.request(sentence), &response))));
        ai.output_for(&response, &sig, vrf)
    }
    /// Validly signed but over the 8 KB response cap.
    pub fn over_length(ai: &Ai, sentence: &str, vrf: &[u8; 32]) -> Value {
        let response = ai.envelope(&"x".repeat(9_000));
        let sig = ai.sign_with(&ai.signer, sentence, &response);
        ai.output_for(&response, &sig, vrf)
    }
    /// Validly signed, but `modify` changed the fighter JSON before signing (refused verdict, unknown move, ...).
    pub fn signed_bad_fighter(ai: &Ai, sentence: &str, raw: &Value, vrf: &[u8; 32], modify: impl Fn(&mut Value)) -> Value {
        let mut bad = raw.clone();
        modify(&mut bad);
        ai.good(sentence, &bad, vrf)
    }
    /// Validly signed envelope whose content is not JSON.
    pub fn signed_garbage_content(ai: &Ai, sentence: &str, vrf: &[u8; 32]) -> Value {
        let response = ai.envelope("I am sorry, I cannot help with that.");
        let sig = ai.sign_with(&ai.signer, sentence, &response);
        ai.output_for(&response, &sig, vrf)
    }
}
