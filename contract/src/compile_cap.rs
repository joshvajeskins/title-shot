//! NEAR AI spend cap (docs/BUDGET.md "Contract cap"). Players reach OutLayer (and so the paid compile) through this contract,
//! so the contract counts every compile it requests and refuses new ones with `E_FORGE_CLOSED` once the UTC-day or the total
//! cap is reached. A compile is counted when it is requested (a later refund does not un-count it: the spend happened or may
//! have happened). Cached sentences never compile and are never blocked.
use crate::codes::*;
use crate::events::emit;
use crate::json::{json, Raw};
use crate::util::*;
use crate::{Contract, ContractExt};
use near_sdk::{assert_one_yocto, near};

pub const DAY_NS: u64 = 86_400 * ONE_SEC_NS;
pub const DEFAULT_DAILY: u32 = 60;
pub const DEFAULT_TOTAL: u32 = 250;

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CompileCap {
    pub daily: u32,
    pub total: u32,
    /// UTC day index (`block_timestamp / 1 day`) that `today` counts.
    pub day: u64,
    pub today: u32,
    /// Compiles since the last `reset_compile_counter`.
    pub used: u32,
}

impl CompileCap {
    pub fn new(daily: u32, total: u32) -> Self {
        Self { daily, total, day: now() / DAY_NS, today: 0, used: 0 }
    }

    /// The counters as of the current block (a new UTC day starts `today` at zero).
    pub fn current(&self) -> Self {
        let day = now() / DAY_NS;
        if day == self.day { *self } else { Self { day, today: 0, ..*self } }
    }

    pub fn open(&self) -> bool {
        let c = self.current();
        c.today < c.daily && c.used < c.total
    }
}

impl Contract {
    /// Refuse a compile request when either cap is reached. Call before any state change (no toll is debited).
    pub fn check_compile_open(&self) {
        check(self.compile_cap.open(), E_FORGE_CLOSED);
    }

    /// Count one requested compile (called from `start_forge` when `need_compile`).
    pub fn count_compile(&mut self) {
        let mut c = self.compile_cap.current();
        c.today = c.today.saturating_add(1);
        c.used = c.used.saturating_add(1);
        self.compile_cap = c;
    }
}

#[near]
impl Contract {
    /// Owner, 1 yocto. Set the per-UTC-day and the total compile caps (the total counts since `reset_compile_counter`).
    #[payable]
    pub fn set_compile_caps(&mut self, daily: u32, total: u32) {
        assert_one_yocto();
        self.assert_owner();
        let c = self.compile_cap.current();
        self.compile_cap = CompileCap { daily, total, ..c };
        emit("compile_caps", json!({ "daily": daily, "total": total }));
    }

    /// Owner, 1 yocto. Zero both counters (used on NEAR AI key rotation: a new key has a fresh budget).
    #[payable]
    pub fn reset_compile_counter(&mut self) {
        assert_one_yocto();
        self.assert_owner();
        let c = self.compile_cap;
        self.compile_cap = CompileCap::new(c.daily, c.total);
        emit("compile_counter_reset", json!({ "daily": c.daily, "total": c.total }));
    }

    /// `{daily, total, today, used, day, open}`: `today` counts the current UTC day (`day` = `block_timestamp / 1 day`).
    pub fn get_compile_caps(&self) -> Raw {
        let c = self.compile_cap.current();
        json!({ "daily": c.daily, "total": c.total, "today": c.today, "used": c.used, "day": c.day, "open": self.compile_cap.open() })
    }
}
