//! Forge callback spike. `forge` asks OutLayer to run the Title Shot forge exactly once, then
//! `on_forged` receives the compact result, logs its size and fields, verifies the VRF proof
//! against the pinned OutLayer VRF key, and handles a null/failed result (timeout path).
//! It never panics in the callback, so the caller's refund always goes out.
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

const REQUEST_GAS: Gas = Gas::from_tgas(150);
const CALLBACK_GAS: Gas = Gas::from_tgas(40);

/// What the callback concluded about the last run (kept for a view; also logged).
#[derive(Serialize, Clone, Default)]
#[serde(crate = "near_sdk::serde")]
#[near(serializers = [borsh])]
pub struct Last {
    pub challenge_id: u64,
    pub accepted: bool,
    pub reason: String,
    pub result_bytes: u32,
    pub has_ai: bool,
    pub vrf_ok: bool,
    pub vrf_output: String,
    pub block_height: u64,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct ForgeCallback {
    outlayer: AccountId,
    project_id: String,
    model_id: String,
    vrf_pubkey: [u8; 32],
    /// Kept by the contract per run; the rest of the deposit goes back to the caller.
    forge_fee: u128,
    last: Option<Last>,
    /// OutLayer secrets profile holding NEARAI_API_KEY (owner = the project owner account).
    secrets_profile: String,
    secrets_owner: AccountId,
}

#[near]
impl ForgeCallback {
    /// `ignore_state`: a spike may be redeployed and re-initialised in place.
    #[init(ignore_state)]
    pub fn new(
        outlayer: AccountId,
        project_id: String,
        model_id: String,
        vrf_pubkey_hex: String,
        forge_fee: U128,
        secrets_profile: String,
        secrets_owner: AccountId,
    ) -> Self {
        Self {
            outlayer,
            project_id,
            model_id,
            vrf_pubkey: parse_key(&vrf_pubkey_hex),
            forge_fee: forge_fee.0,
            last: None,
            secrets_profile,
            secrets_owner,
        }
    }

    /// Real call shape: compile `sentence` with NEAR AI Cloud and draw the VRF seed.
    #[payable]
    pub fn forge(&mut self, sentence: String, challenge_id: u64) -> Promise {
        require!((3..=120).contains(&sentence.chars().count()), "sentence must be 3-120 chars");
        let input = json!({"op": "forge", "sentence": sentence, "need_compile": true,
                           "challenge_id": challenge_id, "model_id": self.model_id});
        self.request(input.to_string(), challenge_id)
    }

    /// Spike helper: VRF only (no AI call), so the VRF path can be proven before a key exists.
    #[payable]
    pub fn forge_vrf_only(&mut self, challenge_id: u64) -> Promise {
        let input = json!({"op": "forge", "need_compile": false, "challenge_id": challenge_id});
        self.request(input.to_string(), challenge_id)
    }

    /// Spike helper: `ping` or `probe` (public GET on cloud-api.near.ai) through the contract.
    #[payable]
    pub fn forge_probe(&mut self, path: String, challenge_id: u64) -> Promise {
        let input = json!({"op": "probe", "path": path});
        self.request(input.to_string(), challenge_id)
    }

    fn request(&mut self, input: String, challenge_id: u64) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() > self.forge_fee, "attach more than the forge fee");
        let args = json!({
            "source": {"Project": {"project_id": self.project_id, "version_key": null}},
            "input_data": input,
            "resource_limits": {"max_instructions": 2_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60},
            "response_format": "Json",
            "secrets_ref": if self.secrets_profile.is_empty() { Value::Null }
                else { json!({"profile": self.secrets_profile, "account_id": self.secrets_owner}) },
        });
        Promise::new(self.outlayer.clone())
            .function_call("request_execution".into(), args.to_string().into_bytes(), deposit, REQUEST_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_forged(challenge_id, env::predecessor_account_id(), U128(deposit.as_yoctonear())),
            )
    }

    /// Resume point. Never panics: the caller always gets `deposit - forge_fee` back.
    #[private]
    pub fn on_forged(
        &mut self,
        challenge_id: u64,
        caller: AccountId,
        deposit: U128,
        #[callback_result] result: Result<Option<Value>, PromiseError>,
    ) -> Last {
        let refund = deposit.0.saturating_sub(self.forge_fee);
        if refund > 0 {
            Promise::new(caller).transfer(NearToken::from_yoctonear(refund));
        }
        let last = self.judge(challenge_id, result);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard": "titleshot_forge_spike", "version": "1.0.0",
                   "event": if last.accepted { "forged" } else { "forge_refused" }, "data": [&last]})
        ));
        self.last = Some(last.clone());
        last
    }

    fn judge(&self, challenge_id: u64, result: Result<Option<Value>, PromiseError>) -> Last {
        let mut last = Last { challenge_id, block_height: env::block_height(), ..Default::default() };
        let out = match result {
            Ok(Some(v)) => v,
            Ok(None) => return Last { reason: "null result (execution failed or timed out)".into(), ..last },
            Err(_) => return Last { reason: "promise failed (no OutLayer response)".into(), ..last },
        };
        last.result_bytes = out.to_string().len() as u32;
        env::log_str(&format!("forge result: {} bytes, fields: {}", last.result_bytes, field_names(&out)));
        if out.get("ok") != Some(&Value::Bool(true)) {
            let code = out.get("code").and_then(Value::as_str).unwrap_or("none");
            let detail = out.get("detail").and_then(Value::as_str).unwrap_or("");
            last.reason = format!("forge error {code}: {}", detail.chars().take(80).collect::<String>());
            return last;
        }
        last.has_ai = out.get("response").is_some() && out.get("signature").is_some();
        let Some(vrf) = out.get("vrf") else {
            last.reason = "no vrf".into();
            return last;
        };
        match self.check_vrf(vrf, challenge_id) {
            Ok(output) => {
                last.vrf_ok = true;
                last.vrf_output = output;
                last.accepted = true;
                last.reason = "ok".into();
            }
            Err(why) => last.reason = format!("vrf: {why}"),
        }
        last
    }

    /// alpha = `vrf:{request_id}:{sender}:titleshot-challenge-{id}`; the proof is ed25519 over alpha.
    fn check_vrf(&self, vrf: &Value, challenge_id: u64) -> Result<String, String> {
        let get = |k: &str| vrf.get(k).and_then(Value::as_str).ok_or(format!("missing {k}"));
        let (alpha, sig_hex, out_hex) = (get("alpha")?, get("signature_hex")?, get("output_hex")?);
        if !alpha.starts_with("vrf:") || !alpha.ends_with(&format!(":titleshot-challenge-{challenge_id}")) {
            return Err("alpha is not for this challenge".into());
        }
        let sig = hex::decode(sig_hex).ok().and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok());
        let sig = sig.ok_or("bad signature_hex")?;
        if !env::ed25519_verify(&sig, alpha.as_bytes(), &self.vrf_pubkey) {
            return Err("signature does not verify".into());
        }
        if hex::encode(env::sha256(&sig)) != out_hex {
            return Err("output is not sha256(signature)".into());
        }
        Ok(out_hex.to_string())
    }

    /// The contract's own key picks the NEAR AI model (spike only; the real contract uses a timelock).
    pub fn set_model(&mut self, model_id: String) {
        require!(env::predecessor_account_id() == env::current_account_id(), "self only");
        require!(!model_id.is_empty() && model_id.len() <= 80, "bad model id");
        self.model_id = model_id;
    }

    pub fn last(&self) -> Option<Last> {
        self.last.clone()
    }

    pub fn config(&self) -> Value {
        json!({"outlayer": self.outlayer, "project_id": self.project_id, "model_id": self.model_id,
               "vrf_pubkey": hex::encode(self.vrf_pubkey), "forge_fee": self.forge_fee.to_string(),
               "secrets_profile": self.secrets_profile, "secrets_owner": self.secrets_owner})
    }
}

fn field_names(v: &Value) -> String {
    v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default()
}

fn parse_key(h: &str) -> [u8; 32] {
    hex::decode(h)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
        .unwrap_or_else(|| env::panic_str("vrf_pubkey_hex must be 32 bytes of hex"))
}

#[cfg(test)]
mod tests;
