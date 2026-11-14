//! Stable error codes. Every refusal panics with exactly one of these strings (see docs/CONTRACT.md).
//! Callback paths never panic: they store a code in the challenge status instead.
use near_sdk::env;

pub const E_NOT_OWNER: &str = "E_NOT_OWNER";
pub const E_NOT_PROMOTER: &str = "E_NOT_PROMOTER";
pub const E_NOT_RELAYER: &str = "E_NOT_RELAYER";
pub const E_NOT_PAYEE: &str = "E_NOT_PAYEE";
pub const E_NO_BELT: &str = "E_NO_BELT";
pub const E_NO_SEASON: &str = "E_NO_SEASON";
pub const E_NO_CHAMPION: &str = "E_NO_CHAMPION";
pub const E_NO_CHALLENGE: &str = "E_NO_CHALLENGE";
pub const E_NO_PAYOUT: &str = "E_NO_PAYOUT";
pub const E_SENTENCE: &str = "E_SENTENCE";
pub const E_SELF: &str = "E_SELF";
pub const E_SAME_SENTENCE: &str = "E_SAME_SENTENCE";
pub const E_PENDING: &str = "E_PENDING";
pub const E_BALANCE: &str = "E_BALANCE";
pub const E_STORAGE: &str = "E_STORAGE";
pub const E_FEE: &str = "E_FEE";
pub const E_TIMELOCK: &str = "E_TIMELOCK";
pub const E_NOT_FORGING: &str = "E_NOT_FORGING";
pub const E_MODE: &str = "E_MODE";
pub const E_CLOSED: &str = "E_CLOSED";
pub const E_TOO_EARLY: &str = "E_TOO_EARLY";
pub const E_PENDING_BOUTS: &str = "E_PENDING_BOUTS";
pub const E_SEASON_OPEN: &str = "E_SEASON_OPEN";
pub const E_DURATION: &str = "E_DURATION";
pub const E_NO_ADDRESS: &str = "E_NO_ADDRESS";
pub const E_BAD_ADDRESS: &str = "E_BAD_ADDRESS";
pub const E_GAS: &str = "E_GAS";
pub const E_DUST: &str = "E_DUST";
pub const E_FEE_NOT_HIGHER: &str = "E_FEE_NOT_HIGHER";
pub const E_SIGNING: &str = "E_SIGNING";
pub const E_NOT_SIGNING: &str = "E_NOT_SIGNING";
pub const E_ALREADY: &str = "E_ALREADY";
pub const E_CONFIG: &str = "E_CONFIG";
pub const E_AMOUNT: &str = "E_AMOUNT";

/// Codes stored in a challenge status (soft paths).
pub const E_AI_SIG: &str = "E_AI_SIG";
pub const E_FORGE_FAILED: &str = "E_FORGE_FAILED";
pub const E_FORGE_OUTPUT: &str = "E_FORGE_OUTPUT";
pub const E_VRF: &str = "E_VRF";
pub const E_TIMEOUT: &str = "E_TIMEOUT";
pub const E_STATE: &str = "E_STATE";

#[inline]
pub fn fail(code: &str) -> ! {
    env::panic_str(code)
}

#[inline]
pub fn check(cond: bool, code: &str) {
    if !cond {
        fail(code)
    }
}
