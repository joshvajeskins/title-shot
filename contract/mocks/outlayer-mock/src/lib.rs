//! outlayer-mock: a test double for `outlayer.testnet`.
//!
//! Models how the real contract talks to a caller (https://app.outlayer.ai/docs/near-integration and
//! Stand-in's `contracts/blocklist`): `request_execution` is payable, needs `source`, `resource_limits`,
//! and returns a *yielded* promise, so the caller's `.then(callback)` runs only when the worker answers.
//! Here the "worker" is the test: it calls `resolve(request_id, output_json)` (success), `fail(request_id)`
//! (execution failed: the callback sees a failed promise) or does nothing (the yield times out after 200
//! blocks and the callback sees a failed promise, exactly like an OutLayer timeout).
//! Settlement mirrors OutLayer: `charge` yoctoNEAR is kept for the run, the rest of the deposit is
//! refunded to `payer_account_id` (default: the caller) when the request is settled.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseResult,
};

const FAIL_SENTINEL: &[u8] = b"__outlayer_mock_execution_failed__";
/// nearcore refuses to resume a yield with more than 1024 payload bytes ("Yield resume payload is N bytes which
/// exceeds the 1024 byte limit", seen in the sandbox). A real AI result is 2.5-3.5 KB, so by default the mock keeps
/// the output in its own state, resumes the yield with this small handle and returns the stored output from
/// `on_resume` (callback return values may be large). `resolve_direct` resumes with the raw payload instead, which
/// reproduces the limit exactly.
const STORED_HANDLE: &[u8] = b"__outlayer_mock_stored_output__";
const RESUME_GAS: Gas = Gas::from_tgas(10);
const MAX_INPUT_BYTES: usize = 1_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Pending,
    Resolved,
    Failed,
    /// Answered after the yield had already timed out: nothing was delivered to the caller.
    TooLate,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub id: u64,
    pub caller: AccountId,
    pub payer: AccountId,
    pub deposit: U128,
    pub prepaid_gas: u64,
    /// The `source` argument as JSON text.
    pub source: String,
    pub resource_limits: String,
    pub input_data: Option<String>,
    pub secrets_ref: Option<String>,
    pub response_format: Option<String>,
    pub created_block: u64,
    pub status: Status,
    pub output: Option<String>,
    pub refunded: U128,
    pub yield_id: Vec<u8>,
}

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
    /// "Worker is down": on a yield timeout, wait again instead of failing the caller's promise (a stuck request).
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

    /// While `hold` is on, a request that nobody answers never fails: it re-yields every 200 blocks (a stuck run).
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

        let args = serde_json::json!({ "request_id": id }).to_string().into_bytes();
        let promise = env::promise_yield_create("on_resume", &args, RESUME_GAS, GasWeight(1), 0);
        let yield_id = env::read_register(0).unwrap_or_else(|| env::panic_str("outlayer-mock: no yield id"));
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
                yield_id,
            },
        );
        env::log_str(&format!("outlayer-mock: request {id} queued"));
        env::promise_return(promise);
    }

    // ----- the "worker": driven by tests -----

    /// Answer with a successful run whose stdout (parsed per response_format) is `output_json`.
    /// Returns false when the yield already timed out (a late answer: nothing is delivered).
    pub fn resolve(&mut self, request_id: u64, output_json: String) -> bool {
        self.settle(request_id, Status::Resolved, output_json.into_bytes(), true)
    }

    /// Like `resolve`, but the payload goes through `promise_yield_resume` as is (fails over 1024 bytes).
    pub fn resolve_direct(&mut self, request_id: u64, output_json: String) -> bool {
        self.settle(request_id, Status::Resolved, output_json.into_bytes(), false)
    }

    /// Answer with an execution failure: the caller's callback sees a failed promise.
    pub fn fail(&mut self, request_id: u64) -> bool {
        self.settle(request_id, Status::Failed, FAIL_SENTINEL.to_vec(), false)
    }

    #[private]
    pub fn on_resume(&mut self, request_id: u64) {
        match env::promise_result(0) {
            PromiseResult::Successful(data) => {
                if data == FAIL_SENTINEL {
                    env::panic_str("outlayer-mock: execution failed");
                }
                if data == STORED_HANDLE {
                    let out = self.requests.get(&request_id).and_then(|r| r.output.clone());
                    env::value_return(out.unwrap_or_default().as_bytes());
                } else {
                    env::value_return(&data);
                }
            }
            PromiseResult::Failed => {
                let held = self.requests.get(&request_id).cloned().filter(|r| self.hold && r.status == Status::Pending);
                let Some(mut r) = held else { env::panic_str("outlayer-mock: execution timed out") };
                let args = serde_json::json!({ "request_id": request_id }).to_string().into_bytes();
                let promise = env::promise_yield_create("on_resume", &args, RESUME_GAS, GasWeight(1), 0);
                r.yield_id = env::read_register(0).unwrap_or_else(|| env::panic_str("outlayer-mock: no yield id"));
                self.requests.insert(request_id, r);
                env::promise_return(promise);
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
    fn settle(&mut self, request_id: u64, status: Status, payload: Vec<u8>, store: bool) -> bool {
        let mut r = self.requests.get(&request_id).cloned().unwrap_or_else(|| env::panic_str("outlayer-mock: unknown request"));
        require!(r.status == Status::Pending, "outlayer-mock: request already settled");
        let yield_id: [u8; 32] = r.yield_id.clone().try_into().unwrap_or_else(|_| env::panic_str("outlayer-mock: bad yield id"));
        if store {
            r.output = Some(String::from_utf8_lossy(&payload).into_owned());
            self.requests.insert(request_id, r.clone());
        }
        let wire: &[u8] = if store { STORED_HANDLE } else { &payload };
        let delivered = env::promise_yield_resume(&yield_id, wire);
        if !delivered && self.hold {
            // The held request is between two yields (a timeout is in flight): nothing changed, try again shortly.
            return false;
        }
        let status = if delivered { status } else { Status::TooLate };
        let refund = r.deposit.0.saturating_sub(self.charge);
        if refund > 0 {
            Promise::new(r.payer.clone()).transfer(NearToken::from_yoctonear(refund));
            r.refunded = U128(refund);
        }
        r.status = status;
        if delivered && r.status == Status::Resolved {
            r.output = Some(String::from_utf8_lossy(&payload).into_owned());
        }
        self.requests.insert(request_id, r);
        delivered
    }
}
