//! Challenge creation, the OutLayer request, the callback, relayer submit and expiry.
use crate::codes::*;
use crate::economy::{clean_sentence, storage_charge};
use crate::events::{emit, hex32};
use crate::forge_out::{self, ParseError};
use crate::types::*;
use crate::util::*;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use crate::json::{json, Null, Raw};
use near_sdk::{env, near, Gas, NearToken, Promise, PromiseResult};

/// Gas reserved for the OutLayer request and for `on_forged` (verify + normalize + bout + split).
pub const REQUEST_GAS: Gas = Gas::from_tgas(150);
pub const CALLBACK_GAS: Gas = Gas::from_tgas(60);

impl Contract {
    /// Schedule `outlayer.request_execution` then `on_forged(challenge_id)`.
    pub fn request_forge(&self, c: &Challenge, fee: u128) {
        let input = json!({
            "op": "forge", "sentence": c.sentence, "need_compile": c.need_compile,
            "challenge_id": c.id, "model_id": self.model_id,
        });
        let secrets = match &self.secrets {
            Some((profile, owner)) => json!({ "profile": profile, "account_id": owner }),
            None => Raw("null".into()),
        };
        let source = json!({ "Project": json!({ "project_id": self.forge_project, "version_key": Null }) });
        let limits = json!({ "max_instructions": 2_000_000_000u64, "max_memory_mb": 128u32, "max_execution_seconds": 60u32 });
        let args = json!({
            "source": source,
            "input_data": input.0,
            "resource_limits": limits,
            "response_format": "Json",
            "secrets_ref": secrets,
        });
        Promise::new(self.outlayer.clone())
            .function_call("request_execution".into(), args.0.into_bytes(), NearToken::from_yoctonear(fee), REQUEST_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_forged(c.id));
    }

    /// Create a challenge record + the forge request (or the relayer event). Used by `challenge` and `open_season`.
    pub fn start_forge(&mut self, mut c: Challenge) -> u64 {
        let id = self.next_challenge;
        self.next_challenge += 1;
        c.id = id;
        c.relayer = self.forge_mode == ForgeMode::Relayer;
        c.need_compile = !self.fighters.contains_key(&c.hash);
        self.stats.challenges += 1;
        self.stats.forging += 1;
        if c.kind == ChallengeKind::Opener {
            // The promoter attached this fee: it came in outside `deposit`, so `owed()` counts it as an inflow.
            self.stats.opener_fees += c.fee;
        }
        emit(
            if c.kind == ChallengeKind::Opener { "opener" } else { "challenge" },
            json!({ "challenge_id": id, "belt_id": c.belt_id, "season_id": c.season_id, "challenger": c.challenger,
                    "sentence": c.sentence, "hash": hex32(&c.hash), "toll": U128(c.toll), "fee": U128(c.fee), "need_compile": c.need_compile }),
        );
        match self.forge_mode {
            ForgeMode::Outlayer => {
                self.stats.fees_spent += c.fee;
                self.request_forge(&c, c.fee);
            }
            ForgeMode::Relayer => {
                // No OutLayer deposit is spent: the fee funds the relayer, it is the protocol's.
                self.protocol_balance += c.fee;
                self.stats.protocol += c.fee;
                emit("forge_requested", json!({ "challenge_id": id, "sentence": c.sentence, "need_compile": c.need_compile }));
            }
        }
        self.challenges.insert(id, c);
        id
    }

    /// Terminal bookkeeping shared by every outcome: pending flags and season counters.
    pub fn finish_challenge(&mut self, c: &mut Challenge, status: Status) {
        if c.status == Status::Forging {
            self.stats.forging = self.stats.forging.saturating_sub(1);
        }
        c.status = status;
        if c.kind == ChallengeKind::Challenge {
            if self.pending.get(&c.challenger) == Some(c.id) {
                self.pending.remove(&c.challenger);
            }
            if let Some(mut s) = self.season_of(c.belt_id, c.season_id) {
                s.pending = s.pending.saturating_sub(1);
                self.seasons.insert((c.belt_id, c.season_id), s);
            }
        }
    }

    /// Refund `toll - fee - storage` to the challenger's balance and record `Refunded{code}`. Soft: never panics.
    /// `before` is the `env::storage_usage()` reading taken when this call started (see `fail_challenge`).
    pub fn refund(&mut self, c: Challenge, code: &str, detail: &str, before: u64) -> Status {
        self.stats.refunds += 1;
        self.fail_challenge(c, Status::Refunded { code: code.to_string() }, "refunded", detail, before)
    }

    pub fn reject(&mut self, c: Challenge, code: &str, detail: &str, before: u64) -> Status {
        self.stats.rejected += 1;
        self.fail_challenge(c, Status::Rejected { code: code.to_string(), detail: detail.to_string() }, "rejected", detail, before)
    }

    /// A failed challenge still leaves storage behind (its record, and a fighter when the compile succeeded before a
    /// resolution guard refunded it). Those bytes are measured exactly as for a bout and charged to the toll, with the same
    /// cap (50% of `toll - fee`), before the rest is refunded. An opener has no toll: its storage is `storage_debt`.
    fn fail_challenge(&mut self, mut c: Challenge, status: Status, event: &str, detail: &str, before: u64) -> Status {
        if c.kind == ChallengeKind::Opener {
            self.abort_opener(&c);
        }
        let code = match &status {
            Status::Refunded { code } | Status::Rejected { code, .. } => code.clone(),
            _ => String::new(),
        };
        self.finish_challenge(&mut c, status.clone());
        self.challenges.insert(c.id, c.clone());
        if c.kind == ChallengeKind::Challenge {
            self.credit(&c.challenger, 0);
        }
        let measured = (self.bytes_since(before) + c.storage_bytes as i64).max(0) as u64;
        let cost = env::storage_byte_cost().as_yoctonear();
        let r = if c.kind == ChallengeKind::Opener { 0 } else { c.toll.saturating_sub(c.fee) };
        let charge = storage_charge(r, measured, cost);
        self.stats.storage_charged += charge;
        self.stats.storage_debt += (measured as u128).saturating_mul(cost).saturating_sub(charge);
        let back = r - charge;
        if back > 0 {
            self.credit(&c.challenger, back);
            self.stats.refunded += back;
        }
        if charge > 0 {
            c.storage_charge = charge;
            self.challenges.insert(c.id, c.clone());
        }
        emit(event, json!({ "challenge_id": c.id, "challenger": c.challenger, "code": code, "detail": detail,
                            "amount": U128(back), "storage": U128(charge), "storage_bytes": measured }));
        status
    }
}

pub fn label(s: &Status) -> &'static str {
    match s {
        Status::Forging => "Forging",
        Status::Resolved { .. } => "Resolved",
        Status::Rejected { .. } => "Rejected",
        Status::Refunded { .. } => "Refunded",
    }
}

#[near]
impl Contract {
    /// Pay the toll from the in-contract balance and challenge the champion. Non-payable (so a
    /// function-call key can call it). Returns the challenge id; poll `get_challenge`.
    pub fn challenge(&mut self, belt_id: u32, sentence: String) -> u64 {
        check(!self.deploy_gates().iter().any(|g| g.blocking), E_NOT_READY);
        let storage_before = env::storage_usage();
        let who = env::predecessor_account_id();
        let belt = self.belts.get(&belt_id).unwrap_or_else(|| fail(E_NO_BELT));
        let season = self.season_of(belt_id, belt.season).unwrap_or_else(|| fail(E_NO_SEASON));
        match season.state {
            SeasonState::Opening => fail(E_NO_CHAMPION),
            SeasonState::Open if now() < season.closes_at => {}
            _ => fail(E_NO_SEASON),
        }
        let champion = belt.champion.unwrap_or_else(|| fail(E_NO_CHAMPION));
        let sentence = clean_sentence(&sentence).unwrap_or_else(|c| fail(c));
        let hash = sha256_str(&sentence);
        check(self.holder(belt_id) != who, E_SELF);
        check(hash != champion, E_SAME_SENTENCE);
        check(!self.pending.contains_key(&who), E_PENDING);
        check(self.balance(&who) >= belt.toll, E_BALANCE);
        self.debit(&who, belt.toll);
        self.stats.tolls += belt.toll;
        let mut season = season;
        season.pending += 1;
        season.challenges += 1;
        self.seasons.insert((belt_id, belt.season), season);
        let c = Challenge {
            id: 0,
            belt_id,
            season_id: belt.season,
            challenger: who.clone(),
            sentence,
            hash,
            status: Status::Forging,
            created_at: now(),
            need_compile: false,
            kind: ChallengeKind::Challenge,
            toll: belt.toll,
            fee: belt.forge_fee,
            relayer: false,
            storage_bytes: 0,
            storage_charge: 0,
        };
        let id = self.start_forge(c);
        self.pending.insert(who, id);
        // The challenge record and the pending flag are permanent storage: their bytes are billed to this bout.
        let bytes = self.bytes_since(storage_before).max(0) as u32;
        if let Some(mut c) = self.challenges.get(&id) {
            c.storage_bytes = bytes;
            self.challenges.insert(id, c);
        }
        id
    }

    /// OutLayer resume point. Soft: every failure refunds, nothing panics.
    #[private]
    pub fn on_forged(&mut self, challenge_id: u64) -> String {
        let input = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => forge_out::parse_bytes(&bytes),
            PromiseResult::Failed => Err(ParseError { code: E_FORGE_FAILED, detail: "promise failed".into() }),
        };
        self.settle(challenge_id, input, false)
    }

    /// Relayer mode: a listed relayer delivers the forge output for a pending challenge.
    pub fn submit_forge(&mut self, challenge_id: u64, output_json: String) -> String {
        check(self.is_relayer(&env::predecessor_account_id()), E_NOT_RELAYER);
        let c = self.challenges.get(&challenge_id).unwrap_or_else(|| fail(E_NO_CHALLENGE));
        check(c.status == Status::Forging, E_NOT_FORGING);
        check(c.relayer, E_MODE);
        self.settle(challenge_id, forge_out::parse_str(&output_json), true)
    }

    /// Anyone, 10 minutes after the challenge: still `Forging` -> refund minus fee. A resolved one is a no-op.
    pub fn expire_challenge(&mut self, id: u64) -> bool {
        let c = self.challenges.get(&id).unwrap_or_else(|| fail(E_NO_CHALLENGE));
        if c.status != Status::Forging {
            return false;
        }
        check(now() >= c.created_at + FORGE_TIMEOUT_NS, E_TOO_EARLY);
        self.refund(c, E_TIMEOUT, "forge timed out", env::storage_usage());
        true
    }
}
