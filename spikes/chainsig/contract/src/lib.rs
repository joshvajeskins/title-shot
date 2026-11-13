//! Chain Signatures payout spike: a NEAR contract signs a Base Sepolia EIP-1559 ETH transfer with no key holder.
mod tx;

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseError, PromiseOrValue,
};
use tx::{parse_address, signed_bytes, unsigned_bytes, TxParams};

const SIGN_GAS: Gas = Gas::from_tgas(40);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const EVENT_STANDARD: &str = "titleshot_payout";

#[allow(dead_code)]
#[ext_contract(ext_signer)]
trait Signer {
    fn sign(&mut self, request: SignRequest);
}

/// Request schema of v1.signer-prod.testnet 3.19.0 `sign` (near/mpc crates/contract/README.md).
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

/// Response of `sign`, verified live: {"scheme":"Secp256k1","big_r":{"affine_point":"03.."},"s":{"scalar":".."},"recovery_id":1}
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

#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub enum PayoutRec {
    Pending(TxParams),
    Signed { params: TxParams, raw_tx: Vec<u8> },
}

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Payouts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Spike {
    owner: AccountId,
    signer: AccountId,
    path: String,
    domain_id: u32,
    chain_id: u64,
    /// Expected derived EVM address; when set, on_signed recovers the signer from (hash, r, s, parity) and refuses a mismatch.
    address: Option<[u8; 20]>,
    payouts: LookupMap<u64, PayoutRec>,
}

#[near]
impl Spike {
    #[init]
    pub fn new(owner: AccountId, signer: AccountId, path: String, domain_id: u32, chain_id: u64) -> Self {
        Self { owner, signer, path, domain_id, chain_id, address: None, payouts: LookupMap::new(Key::Payouts) }
    }

    pub fn set_address(&mut self, address: String) {
        self.assert_owner();
        self.address = Some(parse_address(&address).unwrap_or_else(|e| env::panic_str(e)));
    }

    /// Sign (or replay) a native-ETH payout. Same payout_id after success returns the stored tx without a new signature.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_payout(
        &mut self, payout_id: u64, to: String, value_wei: U128, nonce: u64,
        max_fee_per_gas: U128, max_priority_fee_per_gas: U128, gas_limit: u64,
    ) -> PromiseOrValue<Option<String>> {
        self.assert_owner();
        let params = TxParams {
            chain_id: self.chain_id,
            to: parse_address(&to).unwrap_or_else(|e| env::panic_str(e)),
            value: value_wei.0,
            nonce,
            max_fee_per_gas: max_fee_per_gas.0,
            max_priority_fee_per_gas: max_priority_fee_per_gas.0,
            gas_limit,
        };
        require!(params.gas_limit >= 21_000, "gas_limit below 21000");
        require!(params.max_fee_per_gas >= params.max_priority_fee_per_gas, "max_fee below priority fee");
        match self.payouts.get(&payout_id) {
            Some(PayoutRec::Signed { params: old, raw_tx }) => {
                require!(*old == params, "payout_id already signed with different parameters");
                emit("payout_replayed", json!({ "payout_id": payout_id }));
                return PromiseOrValue::Value(Some(to_hex(raw_tx)));
            }
            Some(PayoutRec::Pending(_)) => env::panic_str("payout_id is being signed"),
            None => {}
        }
        let hash = env::keccak256_array(&unsigned_bytes(&params));
        self.payouts.insert(payout_id, PayoutRec::Pending(params));
        let request = SignRequest { path: self.path.clone(), payload_v2: Payload::Ecdsa(hex::encode(hash)), domain_id: self.domain_id };
        PromiseOrValue::Promise(
            ext_signer::ext(self.signer.clone()).with_static_gas(SIGN_GAS).with_attached_deposit(NearToken::from_yoctonear(1)).sign(request)
                .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_signed(payout_id)),
        )
    }

    /// Soft-fails (clears Pending, returns None) so the payout can be retried; panicking would revert the cleanup.
    #[private]
    pub fn on_signed(&mut self, payout_id: u64, #[callback_result] sig: Result<SignatureResponse, PromiseError>) -> Option<String> {
        let Some(PayoutRec::Pending(params)) = self.payouts.remove(&payout_id) else {
            env::panic_str("no pending payout");
        };
        let fail = |reason: &str| -> Option<String> {
            emit("payout_sign_failed", json!({ "payout_id": payout_id, "reason": reason }));
            None
        };
        let Ok(SignatureResponse::Secp256k1 { big_r, s, recovery_id }) = sig else { return fail("signer_error") };
        let (Some(r), Some(s)) = (hex32(&big_r.affine_point, true), hex32(&s.scalar, false)) else { return fail("bad_signature_encoding") };
        if recovery_id > 1 {
            return fail("recovery_id_gt_1");
        }
        if let Some(expected) = self.address {
            let hash = env::keccak256_array(&unsigned_bytes(&params));
            let mut rs = [0u8; 64];
            rs[..32].copy_from_slice(&r);
            rs[32..].copy_from_slice(&s);
            let ok = env::ecrecover(&hash, &rs, recovery_id, true)
                .map(|pk| env::keccak256_array(&pk)[12..] == expected)
                .unwrap_or(false);
            if !ok {
                return fail("recovered_address_mismatch");
            }
        }
        let raw = signed_bytes(&params, &r, &s, recovery_id);
        let hex_tx = to_hex(&raw);
        emit("payout_signed", json!({
            "payout_id": payout_id, "chain_id": params.chain_id, "nonce": params.nonce,
            "to": format!("0x{}", hex::encode(params.to)), "value_wei": params.value.to_string(), "raw_tx": hex_tx,
        }));
        self.payouts.insert(payout_id, PayoutRec::Signed { params, raw_tx: raw });
        Some(hex_tx)
    }

    pub fn get_raw_tx(&self, payout_id: u64) -> Option<String> {
        match self.payouts.get(&payout_id) {
            Some(PayoutRec::Signed { raw_tx, .. }) => Some(to_hex(raw_tx)),
            _ => None,
        }
    }
    pub fn is_pending(&self, payout_id: u64) -> bool {
        matches!(self.payouts.get(&payout_id), Some(PayoutRec::Pending(_)))
    }
    pub fn get_address(&self) -> Option<String> {
        self.address.map(|a| format!("0x{}", hex::encode(a)))
    }
    /// Unsigned EIP-1559 bytes and the 32-byte digest the MPC signs; lets clients cross-check against viem.
    pub fn preview(&self, to: String, value_wei: U128, nonce: u64, max_fee_per_gas: U128, max_priority_fee_per_gas: U128, gas_limit: u64) -> serde_json::Value {
        let p = TxParams {
            chain_id: self.chain_id, to: parse_address(&to).unwrap_or_else(|e| env::panic_str(e)), value: value_wei.0, nonce,
            max_fee_per_gas: max_fee_per_gas.0, max_priority_fee_per_gas: max_priority_fee_per_gas.0, gas_limit,
        };
        let bytes = unsigned_bytes(&p);
        json!({ "unsigned": to_hex(&bytes), "digest": to_hex(&env::keccak256_array(&bytes)) })
    }
}

impl Spike {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
}

fn to_hex(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// Decode a 32-byte value; for a compressed point (33 bytes) return the x coordinate (bytes 1..33).
fn hex32(s: &str, compressed_point: bool) -> Option<[u8; 32]> {
    let b = hex::decode(s).ok()?;
    let slice = if compressed_point {
        if b.len() != 33 || (b[0] != 2 && b[0] != 3) { return None; }
        &b[1..]
    } else { &b[..] };
    slice.try_into().ok()
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": EVENT_STANDARD, "version": "1.0.0", "event": event, "data": [data] })));
}
