//! Wire and state types of the mock (shapes copied from the real contract's lib.rs:301-362).
use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, Value};
use near_sdk::AccountId;

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Pending,
    Resolved,
    Failed,
    /// Answered after the yield had already timed out: nothing was delivered to the caller.
    TooLate,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub enum ExecutionOutput {
    Bytes(Vec<u8>),
    Text(String),
    Json(Value),
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct ResourceMetrics {
    pub instructions: u64,
    pub time_ms: u64,
    pub compile_time_ms: Option<u64>,
}

/// The resume payload (real: lib.rs:350).
#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct ExecutionResponse {
    pub success: bool,
    pub output: Option<ExecutionOutput>,
    pub error: Option<String>,
    pub resources_used: ResourceMetrics,
    pub compilation_note: Option<String>,
    #[serde(default)]
    pub refund_usd: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub id: u64,
    pub caller: AccountId,
    pub payer: AccountId,
    pub deposit: U128,
    pub prepaid_gas: u64,
    pub source: String,
    pub resource_limits: String,
    pub input_data: Option<String>,
    pub secrets_ref: Option<String>,
    pub response_format: Option<String>,
    pub created_block: u64,
    pub status: Status,
    /// What the caller was (or will be) handed: the JSON bytes as stored.
    pub output: Option<String>,
    pub refunded: U128,
    pub yield_id: Vec<u8>,
    /// Real `ExecutionRequest.pending_output` / `output_submitted` (the 2-call large-output flow).
    pub output_submitted: bool,
    pub pending_output: Option<String>,
    /// Size of the payload the yield was resumed with, and which path carried the output: "inline" | "stored" | "none".
    pub resume_bytes: u64,
    pub output_path: String,
    /// The callback itself fails (a test of the caller's failed-promise handling).
    pub hard_fail: bool,
}


pub fn metrics() -> ResourceMetrics {
    ResourceMetrics { instructions: 955_000, time_ms: 1_800, compile_time_ms: None }
}

pub fn response(success: bool, output: Option<ExecutionOutput>, error: Option<String>) -> ExecutionResponse {
    ExecutionResponse { success, output, error, resources_used: metrics(), compilation_note: None, refund_usd: None }
}

/// Real `output_return_bytes` (execution.rs:893) for the output kinds the forge uses.
pub fn output_bytes(o: Option<&str>) -> Vec<u8> {
    o.map(|s| s.as_bytes().to_vec()).filter(|b| !b.is_empty()).unwrap_or_else(|| b"null".to_vec())
}

/// Real `StoredOutput::Json`: the value re-serialized (keys sorted).
pub fn stored_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

pub fn stored(o: &ExecutionOutput) -> String {
    match o {
        ExecutionOutput::Json(v) => stored_json(v),
        ExecutionOutput::Text(t) => serde_json::to_string(t).unwrap_or_default(),
        ExecutionOutput::Bytes(b) => format!("\"{}\"", b.len()),
    }
}
