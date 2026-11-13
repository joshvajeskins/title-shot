//! Spike: verify a NEAR AI Cloud per-response signature on-chain.
//!
//! The caller supplies the sentence, the exact response bytes and the signature. The contract
//! rebuilds the request bytes itself (fixed prefix ++ json_escape(sentence) ++ fixed suffix),
//! reconstructs the signed text, EIP-191 hashes it, `ecrecover`s the signer and requires the
//! address to be allowlisted. Only then does it parse `choices[0].message.content`.
pub mod verify;

#[cfg(test)]
mod tests;

use near_sdk::json_types::Base64VecU8;
use near_sdk::serde::Serialize;
use near_sdk::{env, near, require, PanicOnDefault};
use verify::{code, Kind};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    allowlist: Vec<[u8; 20]>,
    prefix: Vec<u8>,
    suffix: Vec<u8>,
    model_id: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyOut {
    pub ok: bool,
    pub code: String,
    /// Recovered signer address (set whenever recovery succeeded, even if not allowlisted).
    pub signer: Option<String>,
    /// choices[0].message.content of the verified response (only when ok).
    pub content: Option<String>,
    pub request_sha256: Option<String>,
    pub response_sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub allowlist: Vec<String>,
    pub model_id: String,
    pub prefix_len: u32,
    pub suffix_len: u32,
    pub prefix_sha256: String,
    pub suffix_sha256: String,
}

fn fail(c: &str) -> VerifyOut {
    VerifyOut { ok: false, code: c.to_string(), signer: None, content: None, request_sha256: None, response_sha256: None }
}

#[near]
impl Contract {
    #[init]
    pub fn new(allowlist: Vec<String>, prefix: Base64VecU8, suffix: Base64VecU8, model_id: String) -> Self {
        require!(!allowlist.is_empty() && allowlist.len() <= 8, "allowlist must hold 1..=8 addresses");
        let allowlist: Vec<[u8; 20]> = allowlist
            .iter()
            .map(|a| verify::parse_address(a).unwrap_or_else(|| env::panic_str("bad allowlist address")))
            .collect();
        require!(!model_id.is_empty() && model_id.len() <= 128, "bad model_id");
        require!(!prefix.0.is_empty() && !suffix.0.is_empty(), "prefix/suffix must be non-empty");
        Self { allowlist, prefix: prefix.0, suffix: suffix.0, model_id }
    }

    pub fn get_config(&self) -> Config {
        Config {
            allowlist: self.allowlist.iter().map(verify::addr_hex).collect(),
            model_id: self.model_id.clone(),
            prefix_len: self.prefix.len() as u32,
            suffix_len: self.suffix.len() as u32,
            prefix_sha256: hex::encode(env::sha256_array(&self.prefix)),
            suffix_sha256: hex::encode(env::sha256_array(&self.suffix)),
        }
    }

    /// Never panics on bad input: returns `{ok:false, code}` with a stable code.
    pub fn verify_forge(
        &self,
        sentence: String,
        response: String,
        signature_hex: String,
        signing_algo: String,
        signature_kind: String,
    ) -> VerifyOut {
        if signing_algo != "ecdsa" {
            return fail(code::ALGO);
        }
        let Some(kind) = Kind::parse(&signature_kind) else {
            return fail(code::KIND);
        };
        if sentence.len() > verify::MAX_SENTENCE_BYTES {
            return fail(code::SENTENCE_SIZE);
        }
        if response.len() > verify::MAX_RESPONSE_BYTES {
            return fail(code::RESPONSE_SIZE);
        }
        let (rs, v) = match verify::decode_sig(&signature_hex) {
            Ok(x) => x,
            Err(c) => return fail(c),
        };

        let req = verify::request_bytes(&self.prefix, &self.suffix, &sentence);
        let req_hash = env::sha256_array(&req);
        let resp_hash = env::sha256_array(response.as_bytes());
        let text = verify::signed_text(kind, &self.model_id, &req_hash, &resp_hash);
        let digest = verify::eip191_digest(&text);

        let mut out = fail(code::RECOVER);
        out.request_sha256 = Some(hex::encode(req_hash));
        out.response_sha256 = Some(hex::encode(resp_hash));
        // malleability_flag = true rejects high-s signatures.
        let Some(pubkey) = env::ecrecover(&digest, &rs, v, true) else {
            return out;
        };
        let signer = verify::address_of(&pubkey);
        out.signer = Some(verify::addr_hex(&signer));
        if !self.allowlist.contains(&signer) {
            out.code = code::SIGNER.to_string();
            return out;
        }
        match verify::extract_content(&response) {
            Ok(content) => {
                out.ok = true;
                out.code = code::OK.to_string();
                out.content = Some(content);
            }
            Err(c) => out.code = c.to_string(),
        }
        out
    }
}
