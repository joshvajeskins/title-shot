//! signer-mock: a test double for the MPC signer (`v1.signer-prod.testnet`, CaitSith secp256k1 domain 0).
//!
//! Same request and response schema as the real signer (near/mpc crates/contract README, verified live in
//! spikes/chainsig/RESULT.md):
//!   sign({"request":{"payload_v2":{"Ecdsa":"<64 hex>"},"path":"belt-1-s1","domain_id":0}})
//!     -> {"scheme":"Secp256k1","big_r":{"affine_point":"03<x:64hex>"},"s":{"scalar":"<64hex>"},"recovery_id":1}
//!   derived_public_key(path, predecessor, domain_id) -> "secp256k1:<base58(X||Y)>"
//! The key for (predecessor, path, domain) is sk = sha256("signer-mock-v1|predecessor|path|domain") (re-hashed
//! until it is a valid scalar), so a test can compute any "derived EVM address" natively and the contract's
//! address check is real.
//! Like the real signer: >= 1 yocto attached, >= 10 Tgas prepaid, payload must be 32 bytes < field prime,
//! s is low-s normalised and the signed message is the payload as is (no further hash).
//! Failure injection (`set_mode`): normal | fail (panic) | wrong_key | high_s | bad_recovery.
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::PrimeField;
use k256::sha2::{Digest, Sha256};
use k256::Scalar;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, Gas, PanicOnDefault};

const MIN_GAS: Gas = Gas::from_tgas(10);
/// secp256k1 field prime p (the real signer rejects payloads >= p).
const FIELD_P: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xfc, 0x2f,
];

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Option<Payload>,
    pub domain_id: Option<u32>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Call {
    pub caller: AccountId,
    pub path: String,
    pub payload_hex: String,
    pub domain_id: u32,
    pub deposit: String,
    pub prepaid_gas: u64,
    pub mode: String,
    pub block_height: u64,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct SignerMock {
    mode: String,
    calls: Vec<Call>,
}

fn derive(predecessor: &str, path: &str, domain: u32, salt: &str) -> SigningKey {
    let mut h = Sha256::new();
    h.update(format!("signer-mock-v1|{salt}{predecessor}|{path}|{domain}").as_bytes());
    let mut cur: [u8; 32] = h.finalize().into();
    loop {
        if let Ok(k) = SigningKey::from_bytes((&cur).into()) {
            return k;
        }
        cur = Sha256::digest(cur).into();
    }
}

fn pubkey64(k: &SigningKey) -> [u8; 64] {
    let pt = k.verifying_key().to_encoded_point(false);
    let mut out = [0u8; 64];
    out.copy_from_slice(&pt.as_bytes()[1..65]);
    out
}

#[near]
impl SignerMock {
    #[init]
    pub fn new() -> Self {
        Self { mode: "normal".into(), calls: vec![] }
    }

    /// normal | fail | wrong_key | high_s | bad_recovery
    pub fn set_mode(&mut self, mode: String) {
        require!(matches!(mode.as_str(), "normal" | "fail" | "wrong_key" | "high_s" | "bad_recovery"), "unknown mode");
        self.mode = mode;
    }

    pub fn get_mode(&self) -> String {
        self.mode.clone()
    }

    pub fn get_calls(&self) -> Vec<Call> {
        self.calls.clone()
    }

    pub fn call_count(&self) -> u64 {
        self.calls.len() as u64
    }

    /// `secp256k1:<base58(X||Y)>` exactly like the real signer; derive the EVM address natively from it.
    pub fn derived_public_key(&self, path: String, predecessor: AccountId, domain_id: Option<u32>) -> String {
        let k = derive(predecessor.as_str(), &path, domain_id.unwrap_or(0), "");
        format!("secp256k1:{}", bs58::encode(pubkey64(&k)).into_string())
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Value {
        require!(env::attached_deposit().as_yoctonear() >= 1, "signer-mock: attach at least 1 yoctoNEAR");
        require!(env::prepaid_gas() >= MIN_GAS, "signer-mock: attach at least 10 Tgas");
        let domain = request.domain_id.unwrap_or(0);
        require!(domain == 0, "signer-mock: only domain 0 (secp256k1) is supported");
        let hex_payload = match request.payload_v2 {
            Some(Payload::Ecdsa(h)) => h,
            Some(Payload::Eddsa(_)) => env::panic_str("signer-mock: Eddsa payload on a secp256k1 domain"),
            None => env::panic_str("signer-mock: payload_v2 is required"),
        };
        let mut payload = [0u8; 32];
        require!(
            hex_payload.len() == 64 && hex::decode_to_slice(&hex_payload, &mut payload).is_ok(),
            "signer-mock: payload must be 64 hex chars"
        );
        require!(payload < FIELD_P, "signer-mock: payload must be below the field prime");
        let caller = env::predecessor_account_id();
        self.calls.push(Call {
            caller: caller.clone(),
            path: request.path.clone(),
            payload_hex: hex_payload,
            domain_id: domain,
            deposit: env::attached_deposit().as_yoctonear().to_string(),
            prepaid_gas: env::prepaid_gas().as_gas(),
            mode: self.mode.clone(),
            block_height: env::block_height(),
        });
        if self.mode == "fail" {
            env::panic_str("signer-mock: signing failed (injected)");
        }
        let salt = if self.mode == "wrong_key" { "wrong|" } else { "" };
        let key = derive(caller.as_str(), &request.path, domain, salt);
        let (sig, rec) = key.sign_prehash_recoverable(&payload).unwrap_or_else(|_| env::panic_str("signer-mock: sign failed"));
        let r = sig.r().to_bytes();
        let mut s = sig.s().to_bytes();
        let mut recovery_id = rec.to_byte();
        match self.mode.as_str() {
            "high_s" => {
                s = (-Scalar::from_repr(s).unwrap()).to_bytes();
                recovery_id ^= 1;
            }
            "bad_recovery" => recovery_id ^= 1,
            _ => {}
        }
        let mut big_r = vec![if recovery_id & 1 == 1 { 3u8 } else { 2u8 }];
        big_r.extend_from_slice(&r);
        json!({
            "scheme": "Secp256k1",
            "big_r": {"affine_point": hex::encode(big_r)},
            "s": {"scalar": hex::encode(s)},
            "recovery_id": recovery_id,
        })
    }
}
