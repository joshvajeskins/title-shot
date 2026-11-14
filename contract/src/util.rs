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
/// A payee-signed payout tx that is still the stored one this long after signing may be replaced by anyone, at a strictly
/// higher (still 1%-clamped) fee: a payee can never hold the later nonces of the purse hostage.
pub const PAYEE_GRACE_NS: u64 = 1800 * ONE_SEC_NS;
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
    crate::hex::decode_to_slice(s.strip_prefix("0x").unwrap_or(s), &mut out).ok()?;
    Some(out)
}

impl Contract {
    pub fn assert_owner(&self) {
        check(env::predecessor_account_id() == self.owner, E_NOT_OWNER);
    }

    pub fn belt(&self, id: u32) -> Belt {
        self.belts.get(&id).unwrap_or_else(|| fail(E_NO_BELT))
    }

    pub fn season_of(&self, belt_id: u32, season_id: u32) -> Option<Season> {
        self.seasons.get(&(belt_id, season_id))
    }

    /// Current NFT holder of a belt.
    pub fn holder(&self, belt_id: u32) -> AccountId {
        self.holders.get(&belt_id).unwrap_or_else(|| fail(E_NO_BELT))
    }

    pub fn balance(&self, who: &AccountId) -> u128 {
        self.balances.get(who).unwrap_or(0)
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
    /// flight. Every NEAR that entered through `deposit` (or as an opener fee the promoter attached) and has neither been withdrawn, spent on a forge fee
    /// nor paid out as protocol share is still owed to someone. (OutLayer's refund of an unused fee is not counted:
    /// it only adds to the endowment.)
    pub fn owed(&self) -> u128 {
        let s = &self.stats;
        (s.deposits + s.opener_fees)
            .saturating_sub(s.withdrawn)
            .saturating_sub(s.fees_spent)
            .saturating_sub(s.protocol_withdrawn)
            .saturating_sub(s.storage_charged)
    }

    /// NEAR the endowment (balance beyond what is owed) is short of paying the permanent storage; 0 when it is not short.
    /// The owner's protocol share must absorb this shortfall before it can leave.
    pub fn storage_deficit(&self) -> u128 {
        let need = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear() + self.owed();
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

/// One unmet deploy condition (see `get_deploy_gates`).
pub struct Gate {
    pub name: &'static str,
    pub why: &'static str,
    /// A blocking gate makes `challenge` refuse with `E_NOT_READY`.
    pub blocking: bool,
}

impl Contract {
    /// Unmet deploy conditions. Blocking: a misconfigured deploy must not run a bout, because its seed or its AI
    /// signature check would not be what the README promises.
    pub fn deploy_gates(&self) -> Vec<Gate> {
        let mut out = vec![];
        let outlayer = self.forge_mode == ForgeMode::Outlayer;
        if outlayer && self.vrf_pubkey.is_none() {
            out.push(Gate { name: "vrf_pubkey", blocking: true, why: "no pinned VRF key (set_vrf_pubkey)" });
        }
        if self.allowlist.is_empty() {
            out.push(Gate { name: "allowlist", blocking: true, why: "no AI signer allowlisted (propose_allowlist)" });
        }
        if self.req_prefix.is_empty() || self.req_suffix.is_empty() || self.model_id.is_empty() {
            out.push(Gate { name: "request", blocking: true, why: "compile request not set (set_request)" });
        }
        if outlayer && self.secrets.is_none() {
            out.push(Gate { name: "forge_secrets", blocking: false, why: "no forge secrets profile (set_forge_secrets)" });
        }
        if self.forge_mode == ForgeMode::Relayer {
            out.push(Gate { name: "forge_mode", blocking: false, why: "relayer mode: block seed, weaker than the VRF" });
        }
        out
    }

    /// Storage bytes used since `before` (a `env::storage_usage()` reading). May be negative.
    pub fn bytes_since(&self, before: u64) -> i64 {
        env::storage_usage() as i64 - before as i64
    }
}
