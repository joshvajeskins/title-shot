//! Challenge creation, the OutLayer request, the callback, relayer submit and expiry.
use crate::codes::*;
use crate::economy::clean_sentence;
use crate::events::{emit, hex32};
use crate::forge_out::{self, ParseError};
use crate::types::*;
use crate::util::*;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
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
            None => Value::Null,
        };
        let args = json!({
            "source": { "Project": { "project_id": self.forge_project, "version_key": null } },
            "input_data": input.to_string(),
            "resource_limits": { "max_instructions": 2_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 },
            "response_format": "Json",
            "secrets_ref": secrets,
        });
        Promise::new(self.outlayer.clone())
            .function_call("request_execution".into(), args.to_string().into_bytes(), NearToken::from_yoctonear(fee), REQUEST_GAS)
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
        c.status = status;
        if c.kind == ChallengeKind::Challenge {
            if self.pending.get(&c.challenger) == Some(&c.id) {
                self.pending.remove(&c.challenger);
            }
            if let Some(mut s) = self.season_of(c.belt_id, c.season_id) {
                s.pending = s.pending.saturating_sub(1);
                self.seasons.insert((c.belt_id, c.season_id), s);
            }
        }
    }

    /// Refund `toll - fee` to the challenger's balance and record `Refunded{code}`. Soft: never panics.
    pub fn refund(&mut self, mut c: Challenge, code: &str, detail: &str) -> Status {
        self.return_toll(&c);
        let status = Status::Refunded { code: code.to_string() };
        self.stats.refunds += 1;
        emit("refunded", json!({ "challenge_id": c.id, "challenger": c.challenger, "code": code, "detail": detail,
                                 "amount": U128(c.toll.saturating_sub(c.fee)) }));
        self.finish_challenge(&mut c, status.clone());
        self.challenges.insert(c.id, c);
        status
    }

    pub fn reject(&mut self, mut c: Challenge, code: &str, detail: &str) -> Status {
        self.return_toll(&c);
        let status = Status::Rejected { code: code.to_string(), detail: detail.to_string() };
        self.stats.rejected += 1;
        emit("rejected", json!({ "challenge_id": c.id, "challenger": c.challenger, "code": code, "detail": detail,
                                 "amount": U128(c.toll.saturating_sub(c.fee)) }));
        self.finish_challenge(&mut c, status.clone());
        self.challenges.insert(c.id, c);
        status
    }

    fn return_toll(&mut self, c: &Challenge) {
        if c.kind == ChallengeKind::Opener {
            self.abort_opener(c);
            return;
        }
        let back = c.toll.saturating_sub(c.fee);
        if back > 0 {
            self.credit(&c.challenger, back);
            self.stats.refunded += back;
        }
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
        let who = env::predecessor_account_id();
        let belt = self.belts.get(&belt_id).cloned().unwrap_or_else(|| fail(E_NO_BELT));
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
        };
        let id = self.start_forge(c);
        self.pending.insert(who, id);
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
        let c = self.challenges.get(&challenge_id).cloned().unwrap_or_else(|| fail(E_NO_CHALLENGE));
        check(c.status == Status::Forging, E_NOT_FORGING);
        check(c.relayer, E_MODE);
        self.settle(challenge_id, forge_out::parse_str(&output_json), true)
    }

    /// Anyone, 10 minutes after the challenge: still `Forging` -> refund minus fee. A resolved one is a no-op.
    pub fn expire_challenge(&mut self, id: u64) -> bool {
        let c = self.challenges.get(&id).cloned().unwrap_or_else(|| fail(E_NO_CHALLENGE));
        if c.status != Status::Forging {
            return false;
        }
        check(now() >= c.created_at + FORGE_TIMEOUT_NS, E_TOO_EARLY);
        self.refund(c, E_TIMEOUT, "forge timed out");
        true
    }
}
