//! Small helpers: units, JSON shape tolerance, failure inspection, event parsing.
use near_workspaces::result::ExecutionFinalResult;
use serde_json::Value;

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const MILLI: u128 = 1_000_000_000_000_000_000_000;
/// ACCOUNT_STORAGE in docs/CONTRACT.md: 0.005 NEAR kept by the contract on an account's first deposit.
pub const ACCOUNT_STORAGE: u128 = 5 * MILLI;
pub const MIN_FORGE_FEE: u128 = 10 * MILLI;

/// U128/U64 strings or plain numbers -> u128.
pub fn u(v: &Value) -> u128 {
    match v {
        Value::String(s) => s.parse().unwrap_or_else(|_| panic!("not a number: {s}")),
        Value::Number(n) => n.as_u64().unwrap_or_else(|| panic!("not an unsigned int: {n}")) as u128,
        other => panic!("expected a number, got {other}"),
    }
}

/// Everything a failed run says, flattened (receipt failures, panics, logs) for `contains` checks.
pub fn failure_text(r: &ExecutionFinalResult) -> String {
    let mut s = String::new();
    for f in r.failures() {
        s.push_str(&format!("{f:?}\n"));
    }
    if let Err(e) = r.clone().into_result() {
        s.push_str(&format!("{e:?} {e}\n"));
    }
    s
}

/// The call failed and its panic text carries the stable error code.
pub fn assert_code(r: &ExecutionFinalResult, code: &str, ctx: &str) {
    assert!(r.is_failure(), "{ctx}: expected failure {code}, but the call succeeded (logs: {:?})", r.logs());
    let t = failure_text(r);
    assert!(t.contains(code), "{ctx}: expected {code} in failure, got: {t}");
}

/// A transaction the network refuses to even accept (function-call key misuse) or any failure.
pub fn assert_refused<T: std::fmt::Debug>(r: Result<T, near_workspaces::error::Error>, ctx: &str, needle: &str) {
    match r {
        Err(e) => {
            let t = format!("{e:?} {e}");
            assert!(t.contains(needle), "{ctx}: refused, but not for `{needle}`: {t}");
        }
        Ok(v) => panic!("{ctx}: expected the network/contract to refuse, got Ok({v:?})"),
    }
}

/// NEP-297 events (`EVENT_JSON:{...}`) from all receipts of a run: (event, data[0]).
pub fn events(r: &ExecutionFinalResult) -> Vec<(String, Value)> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|v| v["standard"] == "titleshot")
        .map(|v| (v["event"].as_str().unwrap_or("").to_string(), v["data"][0].clone()))
        .collect()
}

pub fn event(r: &ExecutionFinalResult, name: &str) -> Option<Value> {
    events(r).into_iter().find(|(n, _)| n == name).map(|(_, d)| d)
}

pub fn count_events(r: &ExecutionFinalResult, name: &str) -> usize {
    events(r).iter().filter(|(n, _)| n == name).count()
}

pub fn tgas(g: near_workspaces::types::Gas) -> f64 {
    g.as_gas() as f64 / 1e12
}
