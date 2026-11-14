//! NEP-297 events: `EVENT_JSON:{"standard":"titleshot","version":"1.0.0","event":..,"data":[{..}]}`.
use crate::json::{arr, json, Raw};
use near_sdk::env;

pub const STANDARD: &str = "titleshot";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Raw) {
    let body = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": arr([data]) });
    env::log_str(&format!("EVENT_JSON:{}", body.0));
}

pub fn hex32(h: &[u8; 32]) -> String {
    crate::hex::encode(h)
}
