//! Seasons: opening (the promoter's opener forge), the bell (`close_season`), purse address and payout creation.
use crate::codes::*;
use crate::economy::{clean_sentence, fold_dust, plan_purse, MAX_PURSE_WEI, MIN_PAYOUT_WEI};
use crate::events::{emit, hex32};
use crate::types::*;
use crate::util::*;
use crate::verify::addr_hex;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use crate::json::json;
use near_sdk::{assert_one_yocto, env, near, AccountId, NearToken, Promise};

const MIN_DURATION_SEC: u64 = 60;
const MAX_DURATION_SEC: u64 = 30 * 24 * 3600;

fn new_season(duration_sec: u64, purse_wei: u128, state: SeasonState) -> Season {
    Season {
        state,
        duration_ns: duration_sec * ONE_SEC_NS,
        opens_at: 0,
        closes_at: 0,
        rule: None,
        side_pot: 0,
        bouts: 0,
        challenges: 0,
        pending: 0,
        purse_wei,
        purse_address: None,
        purse_next_nonce: 0,
        defenders: vec![],
        payouts: vec![],
        final_holder: None,
    }
}

impl Contract {
    /// Make `belt.season` the open season with `hash` as champion (belt goes to the promoter), or with
    /// the carried-over champion when `hash` is `None` (belt stays with its holder).
    fn activate_season(&mut self, belt_id: u32, season_id: u32, hash: Option<Hash>) {
        let mut belt = self.belt(belt_id);
        let mut season = self.season_of(belt_id, season_id).unwrap_or_else(|| fail(E_NO_SEASON));
        season.state = SeasonState::Open;
        season.opens_at = now();
        season.closes_at = now() + season.duration_ns;
        if let Some(h) = hash {
            let holder = self.holder(belt_id);
            self.move_belt(belt_id, &holder, &belt.promoter);
            belt.champion = Some(h);
            belt.reign_since = now();
            belt.defences = 0;
        }
        belt.season = season_id;
        emit(
            "season_opened",
            json!({ "belt_id": belt_id, "season_id": season_id, "opens_at": season.opens_at.to_string(), "closes_at": season.closes_at.to_string(),
                    "champion": belt.champion.map(|h| hex32(&h)), "holder": self.holder(belt_id), "purse_wei": U128(season.purse_wei) }),
        );
        self.seasons.insert((belt_id, season_id), season);
        self.belts.insert(belt_id, belt);
    }

    /// The opener forged: it is champion with no fight.
    pub fn finish_opener(&mut self, mut c: Challenge) -> Status {
        self.activate_season(c.belt_id, c.season_id, Some(c.hash));
        let status = Status::Resolved { fight_id: None };
        self.finish_challenge(&mut c, status.clone());
        self.challenges.insert(c.id, c);
        status
    }

    /// The opener failed (reject, refund, timeout): the season never opened, the promoter may try again.
    pub fn abort_opener(&mut self, c: &Challenge) {
        if let Some(mut s) = self.season_of(c.belt_id, c.season_id) {
            if s.state == SeasonState::Opening {
                s.state = SeasonState::Aborted;
                self.seasons.insert((c.belt_id, c.season_id), s);
                emit("season_aborted", json!({ "belt_id": c.belt_id, "season_id": c.season_id }));
            }
        }
    }

    fn create_payouts(&mut self, belt_id: u32, season_id: u32, plan: Vec<(AccountId, u128)>) -> Vec<u64> {
        let mut ids = vec![];
        for (payee, amount) in plan {
            let id = self.next_payout;
            self.next_payout += 1;
            let to = self.evm_addrs.get(&payee);
            emit(
                "payout_created",
                json!({ "payout_id": id, "belt_id": belt_id, "season_id": season_id, "payee": payee, "amount_wei": U128(amount),
                        "to": to.map(|a| addr_hex(&a)) }),
            );
            self.payouts.insert(id, Payout { id, belt_id, season_id, payee, amount_wei: amount, to, nonce: None, signed: None, signing: None, signing_by_payee: false });
            ids.push(id);
        }
        ids
    }
}

#[near]
impl Contract {
    /// Promoter only. Forges the opener sentence and opens a season of `duration_sec` with a purse of
    /// `purse_wei` (Base Sepolia wei, declared; paid by Chain Signatures at the bell). Attach at least the belt's
    /// forge fee; the excess is returned. An empty sentence carries the current champion into the new season
    /// (no forge, no fee). A cached opener sentence also opens at once. Returns the season id.
    #[payable]
    pub fn open_season(&mut self, belt_id: u32, opener_sentence: String, duration_sec: u64, purse_wei: U128) -> u32 {
        let who = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let belt = self.belt(belt_id);
        check(who == belt.promoter, E_NOT_PROMOTER);
        // At least 1 yocto always, so a function-call key (which cannot attach a deposit) can never open a season.
        check(attached > 0, E_FEE);
        if let Some(s) = self.season_of(belt_id, belt.season) {
            check(matches!(s.state, SeasonState::Closed | SeasonState::Aborted), E_SEASON_OPEN);
        }
        check((MIN_DURATION_SEC..=MAX_DURATION_SEC).contains(&duration_sec), E_DURATION);
        check(purse_wei.0 <= MAX_PURSE_WEI, E_AMOUNT);
        let season_id = belt.season + 1;
        let carry = opener_sentence.trim().is_empty();
        if carry {
            check(belt.champion.is_some(), E_NO_CHAMPION);
        }
        let sentence = if carry { String::new() } else { clean_sentence(&opener_sentence).unwrap_or_else(|c| fail(c)) };
        let hash = sha256_str(&sentence);
        let cached = !carry && self.fighters.contains_key(&hash);
        let forge_needed = !carry && !cached;
        check(!forge_needed || attached >= belt.forge_fee, E_FEE);
        if forge_needed {
            self.check_compile_open();
        }

        let state = if forge_needed { SeasonState::Opening } else { SeasonState::Open };
        let mut b = belt.clone();
        b.season = season_id;
        self.belts.insert(belt_id, b);
        self.seasons.insert((belt_id, season_id), new_season(duration_sec, purse_wei.0, state));
        let spent = if forge_needed { belt.forge_fee } else { 0 };
        if forge_needed {
            let c = Challenge {
                id: 0, belt_id, season_id, challenger: who.clone(), sentence, hash, status: Status::Forging,
                created_at: now(), need_compile: true, kind: ChallengeKind::Opener, toll: 0, fee: belt.forge_fee, relayer: false, storage_bytes: 0, storage_charge: 0,
            };
            self.start_forge(c);
        } else {
            self.activate_season(belt_id, season_id, if carry { None } else { Some(hash) });
        }
        if attached > spent {
            Promise::new(who).transfer(NearToken::from_yoctonear(attached - spent));
        }
        season_id
    }

    /// The bell. Anyone, after `closes_at`, with no challenge still forging. Idempotent refusal: a second
    /// call is `E_CLOSED`. Creates the payout plan (purse split) and credits the side-pot to the final holder.
    pub fn close_season(&mut self, belt_id: u32) -> Vec<u64> {
        let belt = self.belt(belt_id);
        let mut season = self.season_of(belt_id, belt.season).unwrap_or_else(|| fail(E_NO_SEASON));
        match season.state {
            SeasonState::Closed => fail(E_CLOSED),
            SeasonState::Open => {}
            _ => fail(E_NO_SEASON),
        }
        check(now() >= season.closes_at, E_TOO_EARLY);
        check(season.pending == 0, E_PENDING_BOUTS);
        let holder = self.holder(belt_id);
        let plan = fold_dust(plan_purse(season.purse_wei, &belt.promoter, &holder, &season.defenders, season.bouts), MIN_PAYOUT_WEI);
        if season.side_pot > 0 {
            self.credit(&holder, season.side_pot);
        }
        season.state = SeasonState::Closed;
        season.final_holder = Some(holder.clone());
        let payout_ids = self.create_payouts(belt_id, belt.season, plan);
        season.payouts = payout_ids.clone();
        emit(
            "season_closed",
            json!({ "belt_id": belt_id, "season_id": belt.season, "final_holder": holder, "bouts": season.bouts,
                    "side_pot": U128(season.side_pot), "purse_wei": U128(season.purse_wei), "payouts": payout_ids }),
        );
        self.seasons.insert((belt_id, belt.season), season);
        payout_ids
    }

    /// Promoter or owner: the EVM address derived (off-chain) for this season's purse path. Frozen once a payout is signing or
    /// signed (a failed signing attempt, for example from a wrong address, leaves it correctable).
    #[payable]
    pub fn set_purse_address(&mut self, belt: u32, season: u32, addr: String) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let b = self.belt(belt);
        check(who == b.promoter || who == self.owner, E_NOT_PROMOTER);
        let mut s = self.season_of(belt, season).unwrap_or_else(|| fail(E_NO_SEASON));
        let used = s.payouts.iter().any(|id| self.payouts.get(id).is_some_and(|p| p.signed.is_some() || p.signing.is_some()));
        check(!used, E_ALREADY);
        s.purse_address = Some(parse_addr(&addr));
        self.seasons.insert((belt, season), s);
        emit("purse_address", json!({ "belt_id": belt, "season_id": season, "address": addr.to_ascii_lowercase() }));
    }

    /// The payee registers the EVM address of a payout that was created without one.
    #[payable]
    pub fn claim_payout(&mut self, payout_id: u64, addr: String) {
        assert_one_yocto();
        let mut p = self.payouts.get(&payout_id).unwrap_or_else(|| fail(E_NO_PAYOUT));
        check(p.payee == env::predecessor_account_id(), E_NOT_PAYEE);
        check(p.to.is_none(), E_ALREADY);
        p.to = Some(parse_addr(&addr));
        self.payouts.insert(payout_id, p);
        emit("payout_claimed", json!({ "payout_id": payout_id, "address": addr.to_ascii_lowercase() }));
    }
}
