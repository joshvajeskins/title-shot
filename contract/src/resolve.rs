//! Resolution of a forged challenge: AI signature -> canonical fighter -> seed -> bout -> toll split -> belt.
//! Every failure is soft (refund or reject); the only panics are impossible-state bugs, never inputs.
use crate::challenge::label;
use crate::codes::*;
use crate::economy::{split_toll, storage_charge};
use crate::events::{emit, hex32};
use crate::forge_out::{ForgeOutput, ParseError};
use crate::seed::{block_entropy, derive_seed, source_name, vrf_entropy};
use crate::types::*;
use crate::util::*;
use crate::verify::{self, addr_hex};
use crate::Contract;
use bout_sim::spec::Spec;
use bout_sim::types::Winner;
use near_sdk::json_types::U128;
use crate::json::{json, Raw};
use near_sdk::{env, serde_json};

enum Fail {
    Refund(&'static str, String),
    Reject(&'static str, String),
}

impl Contract {
    /// Shared by the OutLayer callback and `submit_forge`. No-op unless the challenge is still `Forging`.
    pub fn settle(&mut self, id: u64, input: Result<ForgeOutput, ParseError>, _direct: bool) -> String {
        let Some(c) = self.challenges.get(&id) else {
            return "Unknown".to_string();
        };
        if c.status != Status::Forging {
            return label(&c.status).to_string();
        }
        let storage_before = env::storage_usage();
        let status = match input {
            Ok(out) => self.settle_output(c, out, storage_before),
            Err(e) => self.refund(c, e.code, &e.detail, storage_before),
        };
        label(&status).to_string()
    }

    fn settle_output(&mut self, c: Challenge, out: ForgeOutput, storage_before: u64) -> Status {
        if !self.fighters.contains_key(&c.hash) {
            if let Err(f) = self.compile_fighter(&c, &out) {
                return match f {
                    Fail::Refund(code, d) => self.refund(c, code, &d, storage_before),
                    Fail::Reject(code, d) => self.reject(c, code, &d, storage_before),
                };
            }
        }
        if c.kind == ChallengeKind::Opener {
            return self.finish_opener(c);
        }
        self.bout(c, out, storage_before)
    }

    /// Verify the AI signature and store the canonical fighter. `Err` says how to record the failure.
    fn compile_fighter(&mut self, c: &Challenge, out: &ForgeOutput) -> Result<(), Fail> {
        let Some(ai) = &out.ai else {
            return Err(Fail::Refund(E_FORGE_OUTPUT, "no ai response in output".into()));
        };
        let kind = ai.kind.clone().unwrap_or_else(|| if self.gateway_kind { "gateway".into() } else { "provider_tee".into() });
        let verified = verify::verify_ai(&self.verify_ctx(), &c.sentence, &ai.response, &ai.signature, &ai.algo, &kind);
        let v = match verified {
            Ok(v) => v,
            Err(code) => {
                let top = if verify::is_signature_failure(code) { E_AI_SIG } else { code };
                return Err(Fail::Reject(top, code.to_string()));
            }
        };
        let spec = match bout_sim::normalize_str(&v.content) {
            Ok(spec) => spec,
            Err(r) => {
                return Err(Fail::Reject(r.code(), r.to_string()));
            }
        };
        let spec_json = serde_json::to_string(&spec).unwrap_or_default();
        let writer = c.challenger.clone();
        emit(
            "forged",
            json!({ "challenge_id": c.id, "hash": hex32(&c.hash), "writer": writer, "signer": addr_hex(&v.signer),
                    "sentence": c.sentence, "spec": Raw(spec_json.clone()) }),
        );
        self.fighters.insert(
            c.hash,
            Fighter { sentence: c.sentence.clone(), spec_json, writer, forged_at: now(), signer: v.signer, record: Record::default() },
        );
        self.stats.forged += 1;
        Ok(())
    }

    fn load_spec(&self, hash: &Hash) -> Option<Spec> {
        let f = self.fighters.get(hash)?;
        Spec::from_json(&f.spec_json).ok()
    }

    fn bout(&mut self, c: Challenge, out: ForgeOutput, storage_before: u64) -> Status {
        let belt = self.belt(c.belt_id);
        let Some(mut season) = self.season_of(c.belt_id, c.season_id) else {
            return self.refund(c, E_CLOSED, "season missing", storage_before);
        };
        let holder = self.holder(c.belt_id);
        if holder == c.challenger {
            return self.refund(c, E_SELF, "challenger holds the belt", storage_before);
        }
        if season.state != SeasonState::Open {
            return self.refund(c, E_CLOSED, "season closed", storage_before);
        }
        let Some(champ_hash) = belt.champion else {
            return self.refund(c, E_NO_CHAMPION, "no champion", storage_before);
        };
        if champ_hash == c.hash {
            return self.refund(c, E_SAME_SENTENCE, "champion's own sentence", storage_before);
        }
        let (entropy, src) = if c.relayer {
            (block_entropy(c.id), SeedSource::Block)
        } else {
            match out.vrf.as_ref().ok_or("no vrf").and_then(|v| vrf_entropy(v, &self.vrf_pubkey, c.id)) {
                Ok(e) => (e, SeedSource::Vrf),
                Err(why) => return self.refund(c, E_VRF, why, storage_before),
            }
        };
        let (Some(champ), Some(chall)) = (self.load_spec(&champ_hash), self.load_spec(&c.hash)) else {
            return self.refund(c, E_STATE, "stored spec failed validation", storage_before);
        };
        if split_toll(c.toll, c.fee).is_none() {
            return self.refund(c, E_STATE, "toll below fee", storage_before);
        }
        let seed = derive_seed(&entropy, c.id);
        let rule = match season.rule {
            Some(r) => r,
            None => {
                let r = seed[0] % 8;
                season.rule = Some(r);
                emit("rule_revealed", json!({ "belt_id": c.belt_id, "season_id": c.season_id, "rule": r, "challenge_id": c.id }));
                r
            }
        };
        let (winner, state_hash) = bout_sim::simulate_lite(&champ, &chall, seed, rule);

        // Structure first, money second: every permanent record is written (with a zero split) so the bytes this bout
        // stored can be measured, and the storage component can come out of the toll before it is shared.
        self.stats.bouts += 1;
        season.bouts += 1;
        let mut belt = belt;
        let fight_id = self.next_fight;
        self.next_fight += 1;
        belt.fight_count += 1;
        self.belt_fights.insert((c.belt_id, belt.fight_count), fight_id);
        match winner {
            Winner::Challenger => {
                self.move_belt(c.belt_id, &holder, &c.challenger);
                belt.champion = Some(c.hash);
                belt.reign_since = now();
                belt.defences = 0;
                emit("title_change", json!({ "belt_id": c.belt_id, "season_id": c.season_id, "from": holder, "to": c.challenger, "hash": hex32(&c.hash) }));
            }
            _ => {
                belt.defences += 1;
                bump_defender(&mut season, &holder);
            }
        }
        let promoter = belt.promoter.clone();
        self.belts.insert(c.belt_id, belt);
        self.seasons.insert((c.belt_id, c.season_id), season.clone());
        self.record_result(&champ_hash, &c.hash, winner);
        let zero = SplitRec { champion: 0, promoter: 0, side_pot: 0, protocol: 0 };
        let fight = Fight {
            id: fight_id, challenge_id: c.id, belt_id: c.belt_id, season_id: c.season_id, champion_hash: champ_hash,
            challenger_hash: c.hash, holder: holder.clone(), challenger: c.challenger.clone(), seed, seed_source: src, rule,
            winner: winner.code(), state_hash, split: zero, storage: 0, storage_bytes: 0, at: now(),
        };
        self.fights.insert(fight_id, fight);
        let mut c = c;
        let status = Status::Resolved { fight_id: Some(fight_id) };
        self.finish_challenge(&mut c, status.clone());
        self.challenges.insert(c.id, c.clone());
        self.credit(&holder, 0);
        self.credit(&promoter, 0);
        let measured = (self.bytes_since(storage_before) + c.storage_bytes as i64).max(0) as u64;

        let cost = env::storage_byte_cost().as_yoctonear();
        let r = c.toll.saturating_sub(c.fee);
        let charge = storage_charge(r, measured, cost);
        self.stats.storage_charged += charge;
        self.stats.storage_debt += (measured as u128).saturating_mul(cost).saturating_sub(charge);
        let split = split_toll(c.toll, c.fee + charge).unwrap_or_else(|| fail(E_STATE));
        self.credit(&holder, split.champion);
        self.credit(&promoter, split.promoter);
        // finish_challenge already lowered the season's pending count: re-read it before adding the side-pot.
        if let Some(mut s) = self.seasons.get(&(c.belt_id, c.season_id)) {
            s.side_pot += split.side_pot;
            self.seasons.insert((c.belt_id, c.season_id), s);
        }
        self.protocol_balance += split.protocol;
        self.stats.protocol += split.protocol;
        let split_rec = SplitRec { champion: split.champion, promoter: split.promoter, side_pot: split.side_pot, protocol: split.protocol };
        if let Some(mut f) = self.fights.get(&fight_id) {
            f.split = split_rec;
            f.storage = charge;
            f.storage_bytes = measured as u32;
            self.fights.insert(fight_id, f);
        }
        emit(
            "bout",
            json!({ "fight_id": fight_id, "challenge_id": c.id, "belt_id": c.belt_id, "season_id": c.season_id,
                    "champion": hex32(&champ_hash), "challenger_fighter": hex32(&c.hash), "holder": holder, "challenger": c.challenger,
                    "winner": winner_name(winner.code()), "seed": hex32(&seed), "seed_source": source_name(src), "rule": rule,
                    "state_hash": hex32(&state_hash), "storage": U128(charge),
                    "split": json!({ "champion": U128(split.champion), "promoter": U128(split.promoter), "side_pot": U128(split.side_pot), "protocol": U128(split.protocol) }) }),
        );
        status
    }

    fn record_result(&mut self, champ: &Hash, chall: &Hash, winner: Winner) {
        for (h, outcome) in [(champ, 0u8), (chall, 1u8)] {
            if let Some(mut f) = self.fighters.get(h) {
                match (winner, outcome) {
                    (Winner::Draw, _) => f.record.draws += 1,
                    (Winner::Champion, 0) | (Winner::Challenger, 1) => f.record.wins += 1,
                    _ => f.record.losses += 1,
                }
                self.fighters.insert(*h, f);
            }
        }
    }
}

pub fn winner_name(code: u8) -> &'static str {
    match code {
        0 => "champion",
        1 => "challenger",
        _ => "draw",
    }
}

fn bump_defender(season: &mut Season, who: &near_sdk::AccountId) {
    if let Some((_, n)) = season.defenders.iter_mut().find(|(a, _)| a == who) {
        *n += 1;
    } else if season.defenders.len() < MAX_DEFENDERS {
        season.defenders.push((who.clone(), 1));
    }
}
