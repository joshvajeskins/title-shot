//! Bout seed derivation and the OutLayer VRF proof check.
use crate::forge_out::VrfOut;
use crate::types::{Hash, SeedSource};
use near_sdk::env;

pub const SEED_DOMAIN: &[u8] = b"titleshot:seed:";

/// seed = sha256("titleshot:seed:" ++ entropy ++ challenge_id_le)
pub fn derive_seed(entropy: &[u8; 32], challenge_id: u64) -> Hash {
    let mut m = Vec::with_capacity(SEED_DOMAIN.len() + 40);
    m.extend_from_slice(SEED_DOMAIN);
    m.extend_from_slice(entropy);
    m.extend_from_slice(&challenge_id.to_le_bytes());
    env::sha256_array(&m)
}

/// Entropy of a relayer-mode bout: sha256(block random seed ++ challenge_id). Weaker than the VRF
/// (the block producer can influence it): the event says `seed_source: "block"`.
pub fn block_entropy(challenge_id: u64) -> [u8; 32] {
    let mut m = env::random_seed();
    m.extend_from_slice(&challenge_id.to_le_bytes());
    env::sha256_array(&m)
}

/// OutLayer VRF: alpha = `vrf:{request_id}:{sender}:titleshot-challenge-{id}`, proof = ed25519 signature over
/// alpha, output = sha256(proof). With a pinned key every part is verified; without one only the output is used.
pub fn vrf_entropy(vrf: &VrfOut, pubkey: &Option<[u8; 32]>, challenge_id: u64) -> Result<[u8; 32], &'static str> {
    if let Some(pk) = pubkey {
        let alpha = vrf.alpha.as_deref().ok_or("missing alpha")?;
        let sig = vrf.signature.as_ref().ok_or("missing signature_hex")?;
        if !alpha.starts_with("vrf:") || !alpha.ends_with(&format!(":titleshot-challenge-{challenge_id}")) {
            return Err("alpha is not for this challenge");
        }
        if !env::ed25519_verify(sig, alpha.as_bytes(), pk) {
            return Err("proof does not verify");
        }
        if env::sha256_array(sig) != vrf.output {
            return Err("output is not sha256(proof)");
        }
    }
    Ok(vrf.output)
}

pub fn source_name(s: SeedSource) -> &'static str {
    match s {
        SeedSource::Vrf => "vrf",
        SeedSource::Block => "block",
    }
}
