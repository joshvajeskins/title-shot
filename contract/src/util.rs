//! Small shared helpers (storage accessors, balances, hashing).
use crate::codes::*;
use crate::types::*;
use crate::verify::{self, Ctx, Kind};
use crate::Contract;
use near_sdk::{env, AccountId};

pub const ONE_SEC_NS: u64 = 1_000_000_000;
/// Kept by the contract on the first deposit of an account (0.005 NEAR), not credited.
pub const ACCOUNT_STORAGE: u128 = 5_000_000_000_000_000_000_000;
/// Smallest forge fee: covers the OutLayer deposit and the per-fighter storage (0.01 NEAR).
pub const MIN_FORGE_FEE: u128 = 10_000_000_000_000_000_000_000;
/// A forge that has not answered in 10 minutes can be expired by anyone.
pub const FORGE_TIMEOUT_NS: u64 = 600 * ONE_SEC_NS;
/// A signing request that has not answered in 10 minutes can be reset by anyone.
pub const SIGN_TIMEOUT_NS: u64 = 600 * ONE_SEC_NS;
/// Protocol-level price of one stored byte (1e19 yocto).
pub const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;
pub const MAX_DEFENDERS: usize = 64;

pub fn token_id(belt_id: u32) -> String {
    format!("belt-{belt_id}")
}

pub fn sha256_str(s: &str) -> Hash {
    env::sha256_array(s.as_bytes())
}

pub fn now() -> u64 {
    env::block_timestamp()
}

pub fn parse_addr(s: &str) -> Addr {
    verify::parse_address(s).unwrap_or_else(|| fail(E_BAD_ADDRESS))
}

pub fn parse_hash(s: &str) -> Option<Hash> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(s.strip_prefix("0x").unwrap_or(s), &mut out).ok()?;
    Some(out)
}

impl Contract {
    pub fn assert_owner(&self) {
        check(env::predecessor_account_id() == self.owner, E_NOT_OWNER);
    }

    pub fn belt(&self, id: u32) -> Belt {
        self.belts.get(&id).cloned().unwrap_or_else(|| fail(E_NO_BELT))
    }

    pub fn season_of(&self, belt_id: u32, season_id: u32) -> Option<Season> {
        self.seasons.get(&(belt_id, season_id)).cloned()
    }

    /// Current NFT holder of a belt.
    pub fn holder(&self, belt_id: u32) -> AccountId {
        self.tokens.owner_by_id.get(&token_id(belt_id)).unwrap_or_else(|| fail(E_NO_BELT))
    }

    pub fn balance(&self, who: &AccountId) -> u128 {
        self.balances.get(who).copied().unwrap_or(0)
    }

    /// Credit a balance (creating the entry; the contract absorbs the tiny storage of a first entry).
    pub fn credit(&mut self, who: &AccountId, amount: u128) {
        let cur = self.balance(who);
        self.balances.insert(who.clone(), cur + amount);
    }

    pub fn debit(&mut self, who: &AccountId, amount: u128) {
        let cur = self.balance(who);
        check(cur >= amount, E_BALANCE);
        self.balances.insert(who.clone(), cur - amount);
    }

    /// Everything the contract owes in NEAR: all player balances, the protocol share, side-pots and tolls in
    /// flight. Every NEAR that entered through `deposit` and has neither been withdrawn, spent on a forge fee
    /// nor paid out as protocol share is still owed to someone. (OutLayer's refund of an unused fee is not counted:
    /// it only adds to the endowment.)
    pub fn owed(&self) -> u128 {
        let s = &self.stats;
        s.deposits.saturating_sub(s.withdrawn).saturating_sub(s.fees_spent).saturating_sub(s.protocol_withdrawn)
    }

    /// NEAR the endowment (balance beyond what is owed) is short of paying the permanent storage; 0 when it is not short.
    /// The owner's protocol share must absorb this shortfall before it can leave.
    pub fn storage_deficit(&self) -> u128 {
        let need = env::storage_usage() as u128 * STORAGE_BYTE_COST + self.owed();
        need.saturating_sub(env::account_balance().as_yoctonear())
    }

    pub fn is_relayer(&self, who: &AccountId) -> bool {
        self.relayers.contains(who)
    }

    pub fn kind(&self) -> Kind {
        if self.gateway_kind {
            Kind::Gateway
        } else {
            Kind::ProviderTee
        }
    }

    pub fn verify_ctx(&self) -> Ctx<'_> {
        Ctx {
            prefix: &self.req_prefix,
            suffix: &self.req_suffix,
            model_id: &self.model_id,
            kind: self.kind(),
            allowlist: &self.allowlist,
        }
    }
}
