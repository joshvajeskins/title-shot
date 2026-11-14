//! TITLE SHOT+ `titleshot` contract. Interface and rules: docs/CONTRACT.md. This crate adds only what
//! that file leaves open (documented in contract/README.md).
//!
//! A player pays a toll from an in-contract balance (function-call key, no popup). OutLayer runs the
//! forge once per paid challenge; `on_forged` verifies the NEAR AI signature with `ecrecover`,
//! normalizes the spec with `bout-sim`, runs the best-of-3 bout in-contract, splits the toll and
//! moves the NEP-171 belt. The season bell pays the purse on Base Sepolia through Chain Signatures.
#![allow(deprecated)]

pub mod admin;
pub mod b64;
pub mod balances;
pub mod challenge;
pub mod codes;
pub mod economy;
pub mod events;
pub mod forge_out;
pub mod hex;
pub mod json;
pub mod nft;
pub mod payout;
pub mod resolve;
pub mod seed;
pub mod season;
pub mod store;
pub mod signer;
pub mod tx;
pub mod types;
pub mod util;
pub mod verify;
pub mod views;

#[cfg(test)]
mod tests;

use near_sdk::borsh::BorshSerialize;
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault};
use store::Map;
use types::*;

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Key {
    NftOwner,
    Balances,
    Belts,
    Seasons,
    Fighters,
    Challenges,
    Pending,
    Fights,
    BeltFights,
    Payouts,
    EvmAddrs,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub forge_project: String,
    pub mpc_signer: AccountId,
    pub model_id: String,
    pub req_prefix: Vec<u8>,
    pub req_suffix: Vec<u8>,
    /// true = "gateway" signed text, false = "provider_tee".
    pub gateway_kind: bool,
    pub allowlist: Vec<Addr>,
    /// (addresses, activates_at_ns)
    pub pending_allowlist: Option<(Vec<Addr>, u64)>,
    pub allowlist_delay_ns: u64,
    pub forge_mode: ForgeMode,
    /// Staged `set_request` / `set_forge_mode` change (timelocked like the allowlist).
    pub pending_config: Option<PendingConfig>,
    pub relayers: Vec<AccountId>,
    /// OutLayer VRF ed25519 key; when set, the callback verifies every VRF proof against it.
    pub vrf_pubkey: Option<[u8; 32]>,
    /// OutLayer secrets profile holding NEARAI_API_KEY: (profile, owner account).
    pub secrets: Option<(String, AccountId)>,
    /// belt id -> NEP-171 owner (the belt holder).
    pub holders: Map<u32, AccountId>,
    pub balances: Map<AccountId, u128>,
    pub protocol_balance: u128,
    pub belts: Map<u32, Belt>,
    pub belt_count: u32,
    pub seasons: Map<(u32, u32), Season>,
    pub fighters: Map<Hash, Fighter>,
    pub challenges: Map<u64, Challenge>,
    pub next_challenge: u64,
    pub pending: Map<AccountId, u64>,
    pub fights: Map<u64, Fight>,
    pub next_fight: u64,
    /// (belt, sequence 1..=fight_count) -> fight id
    pub belt_fights: Map<(u32, u64), u64>,
    pub payouts: Map<u64, Payout>,
    pub next_payout: u64,
    pub evm_addrs: Map<AccountId, Addr>,
    pub stats: Stats,
}
