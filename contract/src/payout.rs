//! Chain Signatures payouts: build an EIP-1559 Base Sepolia transfer, have the MPC signer sign it, verify the
//! signature recovers to the purse address, store the raw tx for anyone to broadcast.
use crate::codes::*;
use crate::economy::{clamp_stranger_fee, gas_params_ok, payout_value, take_nonce, MIN_PAYEE_FEE_PER_GAS};
use crate::events::emit;
use crate::signer::{ext_signer, hex32, purse_path, Payload, SignRequest, SignatureResponse};
use crate::tx::{signed_bytes, unsigned_bytes, TxParams};
use crate::types::*;
use crate::util::*;
use crate::verify::addr_hex;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use crate::json::json;
use near_sdk::serde_json;
use near_sdk::{env, near, Gas, NearToken, PromiseOrValue, PromiseResult};

const SIGN_GAS: Gas = Gas::from_tgas(40);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

pub fn to_hex(b: &[u8]) -> String {
    format!("0x{}", crate::hex::encode(b))
}

/// Why a signature response was not usable (becomes the `reason` of `payout_sign_failed`).
fn decode_signature(result: PromiseResult) -> Result<([u8; 32], [u8; 32], u8), &'static str> {
    let PromiseResult::Successful(bytes) = result else {
        return Err("signer_error");
    };
    let Ok(SignatureResponse::Secp256k1 { big_r, s, recovery_id }) = serde_json::from_slice::<SignatureResponse>(&bytes) else {
        return Err("bad_signature_response");
    };
    let (Some(r), Some(s)) = (hex32(&big_r.affine_point, true), hex32(&s.scalar, false)) else {
        return Err("bad_signature_encoding");
    };
    if recovery_id > 1 {
        return Err("recovery_id_gt_1");
    }
    Ok((r, s, recovery_id))
}

#[near]
impl Contract {
    /// Anyone (21000 <= gas <= 150000, fee <= 50 gwei): the payee pays `gas_limit * max_fee_per_gas` out of the payout.
    /// The payee's own parameters are used as given. Anyone else (the bell worker) may sign too, but the max fee is
    /// lowered so the gas burn stays within 1% of the payout, and the payee can always replace such a tx with any
    /// parameters. The same parameters again return the stored raw tx; a stuck tx is re-signed with the same nonce
    /// only with a strictly higher `max_fee_per_gas` (the payee replacing a stranger's tx is exempt). The payee's own
    /// max fee is at least 0.001 gwei, and 30 minutes after a nonce was first signed anyone may replace even a
    /// payee-signed tx (higher fee, 1% clamp), so no payee can hold the later nonces of the purse hostage.
    pub fn sign_payout(
        &mut self,
        payout_id: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        gas_limit: u64,
    ) -> PromiseOrValue<Option<String>> {
        let mut p = self.payouts.get(&payout_id).unwrap_or_else(|| fail(E_NO_PAYOUT));
        let to = p.to.unwrap_or_else(|| fail(E_NO_ADDRESS));
        let belt = self.belt(p.belt_id);
        let mut season = self.season_of(p.belt_id, p.season_id).unwrap_or_else(|| fail(E_NO_SEASON));
        check(season.purse_address.is_some(), E_NO_ADDRESS);
        check(gas_params_ok(max_fee_per_gas.0, max_priority_fee_per_gas.0, gas_limit), E_GAS);
        check(p.signing.is_none(), E_SIGNING);
        let by_payee = env::predecessor_account_id() == p.payee;
        let (max_fee_per_gas, max_priority_fee_per_gas) = if by_payee {
            check(max_fee_per_gas.0 >= MIN_PAYEE_FEE_PER_GAS, E_GAS);
            (max_fee_per_gas, max_priority_fee_per_gas)
        } else {
            let (f, pr) = clamp_stranger_fee(p.amount_wei, gas_limit, max_fee_per_gas.0, max_priority_fee_per_gas.0);
            (U128(f), U128(pr))
        };
        let value = payout_value(p.amount_wei, gas_limit, max_fee_per_gas.0).unwrap_or_else(|| fail(E_DUST));
        let nonce = take_nonce(&mut p.nonce, &mut season.purse_next_nonce);
        let params = TxParams {
            chain_id: belt.purse_chain_id,
            to,
            value,
            nonce,
            max_fee_per_gas: max_fee_per_gas.0,
            max_priority_fee_per_gas: max_priority_fee_per_gas.0,
            gas_limit,
        };
        if let Some(st) = &p.signed {
            if st.params == params {
                return PromiseOrValue::Value(Some(to_hex(&st.raw_tx)));
            }
            // The payee overrides a stranger's tx with anything. A stranger overrides the payee's choice only once it has
            // stood for `PAYEE_GRACE_NS` without being replaced (a stuck nonce must not block the later payouts), and only
            // with a strictly higher fee, still clamped to 1%. Same-kind replacements need a strictly higher fee.
            if st.by_payee && !by_payee {
                check(now() >= st.signed_at + PAYEE_GRACE_NS, E_NOT_PAYEE);
            }
            if !by_payee || st.by_payee {
                check(params.max_fee_per_gas > st.params.max_fee_per_gas, E_FEE_NOT_HIGHER);
            }
        }
        let digest = env::keccak256_array(&unsigned_bytes(&params));
        let (belt_id, season_id) = (p.belt_id, p.season_id);
        p.signing = Some((params, now()));
        p.signing_by_payee = by_payee;
        self.payouts.insert(payout_id, p);
        self.seasons.insert((belt_id, season_id), season);
        let request = SignRequest {
            path: purse_path(belt_id, season_id),
            payload_v2: Payload::Ecdsa(crate::hex::encode(digest)),
            domain_id: 0,
        };
        PromiseOrValue::Promise(
            ext_signer::ext(self.mpc_signer.clone())
                .with_static_gas(SIGN_GAS)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .sign(request)
                .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_signed(payout_id, by_payee)),
        )
    }

    /// Soft: any failure clears the signing flag (the payout can be retried) and logs `payout_sign_failed`.
    /// `_by_payee` is ignored: after `reset_payout_signing` a late callback may belong to an older request, so who asked
    /// is read from the request in flight (`signing_by_payee`), like its parameters.
    #[private]
    pub fn on_signed(&mut self, payout_id: u64, _by_payee: bool) -> Option<String> {
        let mut p = self.payouts.get(&payout_id)?;
        let (params, _) = p.signing.take()?;
        let by_payee = p.signing_by_payee;
        let (r, s, rec) = match decode_signature(env::promise_result(0)) {
            Ok(x) => x,
            Err(why) => return self.sign_failed(p, why),
        };
        let Some(expected) = self.season_of(p.belt_id, p.season_id).and_then(|s| s.purse_address) else {
            return self.sign_failed(p, "no_purse_address");
        };
        let digest = env::keccak256_array(&unsigned_bytes(&params));
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&r);
        rs[32..].copy_from_slice(&s);
        let recovered = env::ecrecover(&digest, &rs, rec, true).map(|pk| crate::verify::address_of(&pk));
        if recovered != Some(expected) {
            return self.sign_failed(p, "recovered_address_mismatch");
        }
        let raw = signed_bytes(&params, &r, &s, rec);
        let hex_tx = to_hex(&raw);
        let attempt = p.signed.as_ref().map(|s| s.attempt + 1).unwrap_or(1);
        emit(
            "payout_signed",
            json!({ "payout_id": payout_id, "belt_id": p.belt_id, "season_id": p.season_id, "payee": p.payee, "chain_id": params.chain_id,
                    "nonce": params.nonce, "to": addr_hex(&params.to), "value_wei": U128(params.value),
                    "max_fee_per_gas": U128(params.max_fee_per_gas), "gas_limit": params.gas_limit, "attempt": attempt, "raw_tx": hex_tx }),
        );
        // The grace clock starts at the first signature of this nonce: re-signing (even +1 wei) never restarts it.
        let signed_at = p.signed.as_ref().map(|s| s.signed_at).unwrap_or_else(now);
        p.signed = Some(SignedTx { params, raw_tx: raw, attempt, by_payee, signed_at });
        self.payouts.insert(payout_id, p);
        Some(hex_tx)
    }

    /// Anyone, 10 minutes after a signing request that never answered.
    pub fn reset_payout_signing(&mut self, id: u64) {
        let payout_id = id;
        let mut p = self.payouts.get(&payout_id).unwrap_or_else(|| fail(E_NO_PAYOUT));
        let (_, at) = p.signing.clone().unwrap_or_else(|| fail(E_NOT_SIGNING));
        check(now() >= at + SIGN_TIMEOUT_NS, E_TOO_EARLY);
        p.signing = None;
        self.payouts.insert(payout_id, p);
        emit("payout_sign_reset", json!({ "payout_id": payout_id }));
    }
}

impl Contract {
    /// `p.signing` is already cleared by the caller; a previous signed tx (re-sign case) stays valid.
    fn sign_failed(&mut self, p: Payout, reason: &str) -> Option<String> {
        emit("payout_sign_failed", json!({ "payout_id": p.id, "reason": reason }));
        self.payouts.insert(p.id, p);
        None
    }
}
