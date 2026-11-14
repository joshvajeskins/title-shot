//! MPC signer (Chain Signatures) wire types: request schema of `v1.signer-prod.testnet` 3.19.0 `sign`
//! and its response `{"scheme":"Secp256k1","big_r":{"affine_point":"03.."},"s":{"scalar":".."},"recovery_id":1}`
//! (verified live in spikes/chainsig/RESULT.md).
use near_sdk::ext_contract;
use near_sdk::serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[ext_contract(ext_signer)]
pub trait Signer {
    fn sign(&mut self, request: SignRequest);
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub enum Payload {
    Ecdsa(String),
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 { big_r: BigR, s: Scalar, recovery_id: u8 },
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BigR {
    pub affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    pub scalar: String,
}

/// Decode a 32-byte value; for a compressed point (33 bytes) return the x coordinate (bytes 1..33).
pub fn hex32(s: &str, compressed_point: bool) -> Option<[u8; 32]> {
    let b = hex::decode(s).ok()?;
    let slice = if compressed_point {
        if b.len() != 33 || (b[0] != 2 && b[0] != 3) {
            return None;
        }
        &b[1..]
    } else {
        &b[..]
    };
    slice.try_into().ok()
}

pub fn purse_path(belt_id: u32, season_id: u32) -> String {
    format!("belt-{belt_id}-s{season_id}")
}
