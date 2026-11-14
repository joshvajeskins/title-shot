//! NEP-297 events: `EVENT_JSON:{"standard":"titleshot","version":"1.0.0","event":..,"data":[{..}]}`.
use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "titleshot";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] })
    ));
}

pub fn hex32(h: &[u8; 32]) -> String {
    hex::encode(h)
}
