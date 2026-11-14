//! Scenario driver: tracks the champion/holder/season rule natively so a test can ask for a specific bout
//! result (win, lose, draw) and the harness picks the VRF output that produces it.
use crate::simx;
use crate::world::{Run, World};
use anyhow::Result;
use bout_sim::types::Winner;
use bout_sim::Spec;
use near_workspaces::Account;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;

pub struct Arena<'a> {
    pub w: &'a World,
    pub belt: u32,
    /// The season's fixed rule once the first bout has revealed it.
    pub rule: Option<u8>,
    pub champ: Spec,
    pub champ_sentence: String,
    pub holder: String,
    pub bouts: Vec<Bout>,
}

#[derive(Clone)]
pub struct Bout {
    pub run: Run,
    /// What the contract stored (the truth for balances and belt moves).
    pub winner: Winner,
    /// The result asked for / predicted by the native replay.
    pub want: Winner,
    /// Native replay (same bout-sim, same seed, same rule) agrees with the contract on winner, rule and state hash.
    pub replay_matches: bool,
    pub fight: Value,
    pub vrf: [u8; 32],
    pub rule: u8,
    pub state_hash: [u8; 32],
    pub holder_before: String,
    pub challenger: String,
    pub compiled: bool,
    pub champ_sentence: String,
    pub sentence: String,
}

impl<'a> Arena<'a> {
    /// Creates the belt and opens a season with `opener` as champion (held by the promoter).
    pub async fn open(w: &'a World, opener: (&str, &Value), duration_sec: u64, purse_wei: u128) -> Result<Arena<'a>> {
        let (belt, _) = w.open_belt(opener.0, opener.1, duration_sec, purse_wei).await?;
        Ok(Self::at(w, belt, opener, w.promoter.id().to_string()))
    }

    pub fn at(w: &'a World, belt: u32, champion: (&str, &Value), holder: String) -> Arena<'a> {
        Arena { w, belt, rule: None, champ: simx::spec(champion.1), champ_sentence: champion.0.to_string(), holder, bouts: vec![] }
    }

    /// One paid challenge by `who` whose bout ends as `want`.
    pub async fn fight(&mut self, who: &Account, challenger: (&str, &Value), want: Winner) -> Result<Bout> {
        let (sentence, raw) = (challenger.0.to_string(), challenger.1.clone());
        let known = !self.w.view("get_fighter_by_sentence", json!({"sentence": sentence})).await?.is_null();
        let (champ, chall, rule) = (self.champ.clone(), simx::spec(&raw), self.rule);
        let picked: Rc<RefCell<[u8; 32]>> = Rc::new(RefCell::new([0; 32]));
        let (ai, p2, s2) = (self.w.ai.clone(), picked.clone(), sentence.clone());
        let run = self
            .w
            .run_challenge(who, self.belt, &sentence, move |id| {
                let vrf = simx::find_vrf(&champ, &chall, id, rule, want);
                *p2.borrow_mut() = vrf;
                if known { ai.vrf_only(&vrf) } else { ai.good(&s2, &raw, &vrf) }
            })
            .await?;
        let vrf = *picked.borrow();
        let (predicted, state_hash, rule) = simx::outcome(&self.champ, &simx::spec(challenger.1), &vrf, run.id, self.rule);
        let ch = self.w.challenge_view(run.id).await?;
        anyhow::ensure!(ch["status"] == "Resolved" && !ch["fight_id"].is_null(), "challenge {} did not resolve into a fight: {ch}", run.id);
        let fight = self.w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
        let winner = match fight["winner"].as_str().unwrap_or("") {
            "champion" => Winner::Champion,
            "challenger" => Winner::Challenger,
            "draw" => Winner::Draw,
            other => anyhow::bail!("unknown winner {other} in {fight}"),
        };
        let replay_matches = winner == predicted && fight["rule"] == rule && fight["state_hash"] == hex::encode(state_hash);
        let b = Bout {
            run,
            winner,
            want,
            replay_matches,
            fight: fight.clone(),
            vrf,
            rule: fight["rule"].as_u64().unwrap_or(255) as u8,
            state_hash,
            holder_before: self.holder.clone(),
            challenger: who.id().to_string(),
            compiled: !known,
            champ_sentence: self.champ_sentence.clone(),
            sentence: sentence.clone(),
        };
        self.rule.get_or_insert(b.rule); // the season rule is fixed by the first bout (a sealed rule is revealed there)
        if winner == Winner::Challenger {
            self.champ = simx::spec(challenger.1);
            self.champ_sentence = sentence;
            self.holder = who.id().to_string();
        }
        self.bouts.push(b);
        Ok(self.bouts.last().unwrap().clone())
    }
}

impl Bout {
    /// The bout ended as the test asked. A failure here usually means the wasm was built from a different
    /// bout-sim than the one this test binary links (rebuild contract/res/titleshot.wasm after sim changes).
    pub fn assert_as_asked(&self) {
        assert_eq!(self.winner, self.want, "bout {} ended {:?}, test asked for {:?}: stale wasm vs bout-sim?", self.run.id, self.winner, self.want);
    }

    /// The storage component the contract took out of this bout's toll (measured bytes x price, capped).
    pub fn storage(&self) -> u128 {
        crate::util::u(&self.fight["storage"])
    }

    /// The toll split of this bout: `split(toll, fee + storage)`; the storage must be real (`> 0`, within the 50% cap).
    pub fn split(&self, toll: u128, fee: u128) -> crate::expect::Split {
        let st = self.storage();
        assert!(st > 0 && st <= (toll - fee) / 2, "storage component {st} must be measured and capped: {}", self.fight);
        crate::expect::split(toll, fee + st)
    }

    /// The native replay of the same fighters/seed/rule gives the contract's winner, rule and state hash.
    pub fn assert_replay(&self) {
        assert!(self.replay_matches, "native bout-sim replay differs from the contract's fight: {}", self.fight);
    }
}
