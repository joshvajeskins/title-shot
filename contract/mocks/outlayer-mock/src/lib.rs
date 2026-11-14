//! outlayer-mock: a test double for `outlayer.testnet` that follows the real contract's source line by line
//! (github.com/out-layer/outlayer, `contract/src/execution.rs`, commit 2d50bfa; see contract/README.md "Large outputs").
//!
//! * `request_execution` is payable and returns a *yielded* promise whose callback is `on_execution_response`
//!   (real: execution.rs:323), so the caller's `.then(on_forged)` runs only when the worker answers.
//! * The worker (here: the test) answers in one of two ways, as the real operator does:
//!   - small output (<= 1024 bytes of resume payload): `resolve_execution(request_id, response)` with the output
//!     inside the response (execution.rs:434);
//!   - large output: `submit_execution_output_and_resolve` (execution.rs:393): the output is stored in the request's
//!     state first, then the yield is resumed with metadata only (execution.rs:1073-1077: "avoids the 1024 byte limit
//!     of promise_yield_resume"). `submit_execution_output` + `resolve_execution` is the same in two transactions.
//! * `on_execution_response` (execution.rs:455) takes the output from state when it was submitted separately, refunds
//!   the unused deposit to the payer, and hands the output to the caller with `env::value_return` of the stored JSON
//!   bytes (execution.rs:702, 893): the caller receives them as an ordinary promise result, of any size. A failed run
//!   and a timed-out yield both end in `value_return("null")` (execution.rs:761, 792): the caller never sees a failed promise.
//! * `Json` outputs are stored re-serialized through `serde_json::Value` (execution.rs:323 `From<ExecutionOutput>`):
//!   keys come back sorted, exactly as the real contract returns them.
//!
//! Test helpers on top: `resolve` (picks the right path by size, like the worker), `resolve_direct` (inline whatever the
//! size: reproduces nearcore's 1024-byte limit), `fail` (worker reports a failed run), `fail_hard` (the callback itself
//! dies, e.g. out of gas: the caller sees a failed promise), `set_hold` (a stuck run that never times out).
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError};

mod types;
use types::*;

/// What the real contract reserves for the settlement callback (lib.rs:28 `MIN_RESPONSE_GAS`); unused gas adds by weight.
const RESPONSE_GAS: Gas = Gas::from_tgas(50);
const MAX_INPUT_BYTES: usize = 1_000_000;
/// Largest resume payload nearcore accepts for `promise_yield_resume`.
const YIELD_PAYLOAD_LIMIT: usize = 1024;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Requests,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct OutlayerMock {
    charge: u128,
    min_deposit: u128,
    next_id: u64,
    /// "Worker is down": on a yield timeout, wait again instead of answering `null` (a stuck request).
    hold: bool,
    requests: LookupMap<u64, Request>,
}

#[near]
impl OutlayerMock {
    #[init]
    pub fn new(charge: U128, min_deposit: U128) -> Self {
        Self { charge: charge.0, min_deposit: min_deposit.0, next_id: 1, hold: false, requests: LookupMap::new(Key::Requests) }
    }

    pub fn set_charge(&mut self, charge: U128) {
        self.charge = charge.0;
    }

    /// While `hold` is on, a request that nobody answers never times out: it re-yields every 200 blocks (a stuck run).
    pub fn set_hold(&mut self, hold: bool) {
        self.hold = hold;
    }

    pub fn get_config(&self) -> Value {
        serde_json::json!({"charge": U128(self.charge), "min_deposit": U128(self.min_deposit), "next_id": self.next_id})
    }

    /// Same argument names as the real `request_execution` (unknown extra fields are ignored by the SDK).
    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        let _ = params;
        // "Always pass resource_limits, even as {}: a request without it runs nothing."
        let limits = resource_limits.unwrap_or_else(|| env::panic_str("outlayer-mock: resource_limits is required"));
        require!(limits.is_object(), "outlayer-mock: resource_limits must be an object");
        let ok_source = source.get("Project").map(|p| p.get("project_id").map_or(false, Value::is_string)).unwrap_or(false)
            || source.get("WasmUrl").map(|w| w.get("url").is_some() && w.get("hash").is_some()).unwrap_or(false);
        require!(ok_source, "outlayer-mock: source must be {Project:{project_id}} or {WasmUrl:{url,hash,build_target}}");
        if let Some(f) = &response_format {
            require!(matches!(f.as_str(), "Text" | "Json" | "Bytes"), "outlayer-mock: bad response_format");
        }
        if let Some(i) = &input_data {
            require!(i.len() <= MAX_INPUT_BYTES, "outlayer-mock: input_data too large");
        }
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.min_deposit, "outlayer-mock: attached deposit below the minimum for a run");
        let id = self.next_id;
        self.next_id += 1;
        let caller = env::predecessor_account_id();
        let payer = payer_account_id.unwrap_or_else(|| caller.clone());
        let yield_id = self.yield_for(id);
        self.requests.insert(
            id,
            Request {
                id,
                caller,
                payer,
                deposit: U128(deposit),
                prepaid_gas: env::prepaid_gas().as_gas(),
                source: source.to_string(),
                resource_limits: limits.to_string(),
                input_data,
                secrets_ref: secrets_ref.map(|s| s.to_string()),
                response_format,
                created_block: env::block_height(),
                status: Status::Pending,
                output: None,
                refunded: U128(0),
                yield_id: yield_id.0,
                output_submitted: false,
                pending_output: None,
                resume_bytes: 0,
                output_path: "none".into(),
                hard_fail: false,
            },
        );
        env::log_str(&format!("outlayer-mock: request {id} queued"));
        env::promise_return(yield_id.1);
    }

    // ----- the real operator API (execution.rs) -----

    /// Real `submit_execution_output` (execution.rs:372): store a large output in the request's state.
    pub fn submit_execution_output(&mut self, request_id: u64, output: ExecutionOutput) {
        let mut r = self.pending(request_id);
        require!(!r.output_submitted, "Output already submitted for this request");
        r.pending_output = Some(stored(&output));
        r.output_submitted = true;
        self.requests.insert(request_id, r);
    }

    /// Real `resolve_execution` (execution.rs:434): resume the yield with `response` as the payload. A late answer
    /// (the yield already timed out) returns false instead of panicking, so tests can observe it.
    pub fn resolve_execution(&mut self, request_id: u64, response: ExecutionResponse) -> bool {
        self.resume(request_id, response)
    }

    /// Real `submit_execution_output_and_resolve` (execution.rs:393): store the output, then resume with metadata only.
    pub fn submit_execution_output_and_resolve(&mut self, request_id: u64, output: ExecutionOutput, success: bool, error: Option<String>) -> bool {
        self.submit_execution_output(request_id, output);
        self.resume(request_id, response(success, None, error))
    }

    // ----- test helpers: the "worker" -----

    /// A successful run printing `output_json`. Like the worker: inline when the resume payload fits the 1024-byte
    /// limit, otherwise through the stored-output path. Returns false when the yield already timed out.
    pub fn resolve(&mut self, request_id: u64, output_json: String) -> bool {
        let output = ExecutionOutput::Json(serde_json::from_str(&output_json).unwrap_or(Value::String(output_json)));
        let inline = response(true, Some(output.clone()), None);
        if serde_json::to_vec(&inline).map_or(0, |v| v.len()) <= YIELD_PAYLOAD_LIMIT {
            self.resume(request_id, inline)
        } else {
            self.submit_execution_output_and_resolve(request_id, output, true, None)
        }
    }

    /// Like `resolve`, but the output always rides in the resume payload (fails over 1024 bytes: nearcore's limit).
    pub fn resolve_direct(&mut self, request_id: u64, output_json: String) -> bool {
        let output = ExecutionOutput::Json(serde_json::from_str(&output_json).unwrap_or(Value::String(output_json)));
        self.resume(request_id, response(true, Some(output), None))
    }

    /// The run failed on the worker: the caller is handed `null` (execution.rs:761).
    pub fn fail(&mut self, request_id: u64) -> bool {
        self.resume(request_id, response(false, None, Some("execution failed".into())))
    }

    /// The settlement callback itself dies (for example out of gas): the caller's promise fails.
    pub fn fail_hard(&mut self, request_id: u64) -> bool {
        let mut r = self.pending(request_id);
        r.hard_fail = true;
        self.requests.insert(request_id, r);
        self.resume(request_id, response(false, None, Some("callback failure".into())))
    }

    /// Real `on_execution_response` (execution.rs:455).
    #[private]
    pub fn on_execution_response(&mut self, request_id: u64, #[callback_result] resp: Result<ExecutionResponse, PromiseError>) {
        let Some(mut r) = self.requests.get(&request_id).cloned() else {
            env::value_return(b"null");
            return;
        };
        match resp {
            Ok(resp) => {
                require!(!r.hard_fail, "outlayer-mock: settlement callback failed");
                let out = if r.output_submitted && resp.success { r.pending_output.take() } else { resp.output.as_ref().map(stored) };
                let refund = r.deposit.0.saturating_sub(self.charge);
                self.pay(&mut r, refund);
                r.output = if resp.success { out.clone() } else { None };
                self.requests.insert(request_id, r);
                env::value_return(&output_bytes(if resp.success { out.as_deref() } else { None }));
            }
            Err(_) => {
                // Yield timed out. A held (stuck) run waits another round; otherwise refund minus the base fee, hand `null`.
                if self.hold && r.status == Status::Pending {
                    let (id, promise) = self.yield_for(request_id);
                    r.yield_id = id;
                    self.requests.insert(request_id, r);
                    env::promise_return(promise);
                    return;
                }
                let refund = r.deposit.0.saturating_sub(self.charge);
                self.pay(&mut r, refund);
                self.requests.insert(request_id, r);
                env::value_return(b"null");
            }
        }
    }

    // ----- views -----

    pub fn get_request(&self, request_id: u64) -> Option<Request> {
        self.requests.get(&request_id).cloned()
    }

    pub fn last_request_id(&self) -> u64 {
        self.next_id - 1
    }

    /// Requests `from..=to` (inclusive, capped at 50 rows).
    pub fn get_requests(&self, from: u64, to: u64) -> Vec<Request> {
        (from..=to.min(from + 49)).filter_map(|i| self.requests.get(&i).cloned()).collect()
    }
}

impl OutlayerMock {
    fn yield_for(&self, request_id: u64) -> (Vec<u8>, near_sdk::PromiseIndex) {
        let args = serde_json::json!({ "request_id": request_id }).to_string().into_bytes();
        let promise = env::promise_yield_create("on_execution_response", &args, RESPONSE_GAS, GasWeight(1), 0);
        let id = env::read_register(0).unwrap_or_else(|| env::panic_str("outlayer-mock: no yield id"));
        (id, promise)
    }

    fn pending(&self, request_id: u64) -> Request {
        let r = self.requests.get(&request_id).cloned().unwrap_or_else(|| env::panic_str("Execution request not found"));
        require!(r.status == Status::Pending, "outlayer-mock: request already settled");
        r
    }

    /// Real `resolve_execution_internal` (execution.rs:1047): `promise_yield_resume` with the response JSON.
    fn resume(&mut self, request_id: u64, resp: ExecutionResponse) -> bool {
        let mut r = self.pending(request_id);
        let yield_id: [u8; 32] = r.yield_id.clone().try_into().unwrap_or_else(|_| env::panic_str("outlayer-mock: bad yield id"));
        let payload = serde_json::to_vec(&resp).unwrap_or_default();
        let delivered = env::promise_yield_resume(&yield_id, &payload);
        if !delivered && self.hold {
            // Held request between two yields (a timeout is in flight): nothing changed, try again shortly.
            return false;
        }
        if delivered {
            r.status = if resp.success { Status::Resolved } else { Status::Failed };
            r.resume_bytes = payload.len() as u64;
            r.output_path = if r.output_submitted { "stored" } else if resp.output.is_some() { "inline" } else { "none" }.into();
        } else {
            r.status = Status::TooLate;
            r.output_submitted = false;
            r.pending_output = None;
        }
        self.requests.insert(request_id, r);
        delivered
    }

    /// Refund `amount` of the deposit to the payer (OutLayer keeps `charge` for the run).
    fn pay(&self, r: &mut Request, amount: u128) {
        if amount > 0 && r.refunded.0 == 0 {
            Promise::new(r.payer.clone()).transfer(NearToken::from_yoctonear(amount));
            r.refunded = U128(amount);
        }
    }
}
