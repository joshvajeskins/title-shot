//! JSON views. Hashes are hex strings, u128 are `U128`, nanosecond times are `U64` (strings).
use crate::challenge::label;
use crate::codes::*;
use crate::economy::{clean_sentence, split_toll};
use crate::events::hex32;
use crate::resolve::winner_name;
use crate::seed::source_name;
use crate::signer::purse_path;
use crate::types::*;
use crate::util::*;
use crate::verify::addr_hex;
use crate::{Contract, ContractExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{near, AccountId};

fn state_name(s: SeasonState) -> &'static str {
    match s {
        SeasonState::Opening => "Opening",
        SeasonState::Open => "Open",
        SeasonState::Closed => "Closed",
        SeasonState::Aborted => "Aborted",
    }
}

fn addrs(list: &[Addr]) -> Vec<String> {
    list.iter().map(addr_hex).collect()
}

impl Contract {
    fn fighter_view(&self, hash: &Hash) -> Option<Value> {
        let f = self.fighters.get(hash)?;
        Some(json!({
            "hash": hex32(hash), "sentence": f.sentence,
            "spec": serde_json::from_str::<Value>(&f.spec_json).unwrap_or(Value::Null),
            "writer": f.writer, "forged_at": U64(f.forged_at), "signer": addr_hex(&f.signer),
            "record": { "wins": f.record.wins, "losses": f.record.losses, "draws": f.record.draws },
        }))
    }

    fn season_view(&self, belt_id: u32, id: u32) -> Option<Value> {
        let s = self.season_of(belt_id, id)?;
        Some(json!({
            "id": id, "state": state_name(s.state), "duration_sec": s.duration_ns / ONE_SEC_NS,
            "opens_at": U64(s.opens_at), "closes_at": U64(s.closes_at),
            "rule": s.rule, "sealed": s.rule.is_none(), "side_pot": U128(s.side_pot),
            "bouts": s.bouts, "challenges": s.challenges, "pending": s.pending,
            "purse": { "chain_id": self.belt(belt_id).purse_chain_id, "path": purse_path(belt_id, id), "amount_wei": U128(s.purse_wei),
                       "address": s.purse_address.map(|a| addr_hex(&a)), "next_nonce": s.purse_next_nonce },
            "defence_count": s.defenders.iter().map(|(a, n)| json!({ "account": a, "defences": n })).collect::<Vec<_>>(),
            "payouts": s.payouts, "final_holder": s.final_holder,
        }))
    }

    fn belt_view(&self, id: u32) -> Value {
        let b = self.belt(id);
        let mut top: Vec<(AccountId, u32)> = self.season_of(id, b.season).map(|s| s.defenders).unwrap_or_default();
        top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        top.truncate(10);
        json!({
            "id": id, "name": b.name, "token_id": token_id(id), "promoter": b.promoter, "holder": self.holder(id),
            "toll": U128(b.toll), "forge_fee": U128(b.forge_fee), "purse_chain_id": b.purse_chain_id, "media": b.media,
            "season": self.season_view(id, b.season),
            "champion": b.champion.and_then(|h| self.fighter_view(&h)),
            "reign_since": U64(b.reign_since), "defences": b.defences, "fights": b.fight_count,
            "top_defenders": top.iter().map(|(a, n)| json!({ "account": a, "defences": n })).collect::<Vec<_>>(),
        })
    }

    fn challenge_view(&self, c: &Challenge) -> Value {
        let (code, detail, fight_id) = match &c.status {
            Status::Forging => (None, None, None),
            Status::Resolved { fight_id } => (None, None, *fight_id),
            Status::Rejected { code, detail } => (Some(code.clone()), Some(detail.clone()), None),
            Status::Refunded { code } => (Some(code.clone()), None, None),
        };
        json!({
            "id": c.id, "belt_id": c.belt_id, "season_id": c.season_id, "challenger": c.challenger, "sentence": c.sentence,
            "hash": hex32(&c.hash), "status": label(&c.status), "code": code, "detail": detail, "fight_id": fight_id,
            "created_at": U64(c.created_at), "need_compile": c.need_compile,
            "kind": if c.kind == ChallengeKind::Opener { "Opener" } else { "Challenge" },
            "toll": U128(c.toll), "fee": U128(c.fee), "relayer": c.relayer,
        })
    }

    fn fight_view(&self, f: &Fight) -> Value {
        json!({
            "id": f.id, "challenge_id": f.challenge_id, "belt_id": f.belt_id, "season_id": f.season_id,
            "champion_hash": hex32(&f.champion_hash), "challenger_hash": hex32(&f.challenger_hash),
            "holder": f.holder, "challenger": f.challenger, "seed": hex32(&f.seed), "seed_source": source_name(f.seed_source),
            "rule": f.rule, "winner": winner_name(f.winner), "winner_code": f.winner, "state_hash": hex32(&f.state_hash),
            "split": { "champion": U128(f.split.champion), "promoter": U128(f.split.promoter), "side_pot": U128(f.split.side_pot), "protocol": U128(f.split.protocol) },
            "at": U64(f.at),
        })
    }

    fn payout_view(&self, p: &Payout) -> Value {
        json!({
            "id": p.id, "belt_id": p.belt_id, "season_id": p.season_id, "payee": p.payee, "amount_wei": U128(p.amount_wei),
            "to": p.to.map(|a| addr_hex(&a)), "nonce": p.nonce, "signing": p.signing.is_some(),
            "raw_tx": p.signed.as_ref().map(|s| format!("0x{}", hex::encode(&s.raw_tx))),
            "attempt": p.signed.as_ref().map(|s| s.attempt).unwrap_or(0),
            "value_wei": p.signed.as_ref().map(|s| U128(s.params.value)),
            "max_fee_per_gas": p.signed.as_ref().map(|s| U128(s.params.max_fee_per_gas)),
            "gas_limit": p.signed.as_ref().map(|s| s.params.gas_limit),
        })
    }
}

#[near]
impl Contract {
    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner, "outlayer": self.outlayer, "forge_project": self.forge_project, "mpc_signer": self.mpc_signer,
            "model_id": self.model_id, "signature_kind": if self.gateway_kind { "gateway" } else { "provider_tee" },
            "forge_mode": self.forge_mode.name(), "relayers": self.relayers,
            "prefix_len": self.req_prefix.len(), "suffix_len": self.req_suffix.len(),
            "prefix_sha256": hex::encode(near_sdk::env::sha256_array(&self.req_prefix)),
            "suffix_sha256": hex::encode(near_sdk::env::sha256_array(&self.req_suffix)),
            "allowlist_delay_sec": self.allowlist_delay_ns / ONE_SEC_NS,
            "vrf_pubkey": self.vrf_pubkey.map(hex::encode), "forge_secrets": self.secrets.as_ref().map(|(p, o)| json!({ "profile": p, "owner": o })),
            "belt_count": self.belt_count, "account_storage": U128(ACCOUNT_STORAGE), "min_forge_fee": U128(MIN_FORGE_FEE),
            "forge_timeout_sec": FORGE_TIMEOUT_NS / ONE_SEC_NS,
        })
    }

    /// Deploy gates the contract reports but cannot refuse without breaking the sandbox rig (its fake VRF has no
    /// key). `ok` must be true on the deployed contract before the demo; the deploy script should assert it.
    pub fn get_deploy_gates(&self) -> Value {
        let outlayer = self.forge_mode == ForgeMode::Outlayer;
        let mut failing: Vec<Value> = vec![];
        if outlayer && self.vrf_pubkey.is_none() {
            failing.push(json!({ "gate": "vrf_pubkey", "why": "outlayer mode without a pinned VRF key: bouts are seeded by an unverified output (call set_vrf_pubkey)" }));
        }
        if outlayer && self.secrets.is_none() {
            failing.push(json!({ "gate": "forge_secrets", "why": "outlayer mode without a secrets profile: the forge has no NEAR AI key (call set_forge_secrets)" }));
        }
        if self.forge_mode == ForgeMode::Relayer {
            failing.push(json!({ "gate": "forge_mode", "why": "relayer mode seeds bouts from the block seed, weaker than the VRF" }));
        }
        json!({ "ok": failing.is_empty(), "failing": failing })
    }

    pub fn get_belts(&self) -> Vec<Value> {
        (1..=self.belt_count).map(|i| self.belt_view(i)).collect()
    }

    pub fn get_belt(&self, id: u32) -> Value {
        self.belt_view(id)
    }

    pub fn get_season(&self, belt_id: u32, season_id: u32) -> Option<Value> {
        self.season_view(belt_id, season_id)
    }

    pub fn get_fighter(&self, hash_hex: String) -> Option<Value> {
        self.fighter_view(&parse_hash(&hash_hex)?)
    }

    pub fn get_fighter_by_sentence(&self, sentence: String) -> Option<Value> {
        let cleaned = clean_sentence(&sentence).ok()?;
        self.fighter_view(&sha256_str(&cleaned))
    }

    pub fn get_challenge(&self, id: u64) -> Option<Value> {
        self.challenges.get(&id).map(|c| self.challenge_view(c))
    }

    /// The account's challenge that is still forging, if any.
    pub fn get_pending(&self, account: AccountId) -> Option<Value> {
        let id = self.pending.get(&account)?;
        self.challenges.get(id).map(|c| self.challenge_view(c))
    }

    pub fn get_fight(&self, id: u64) -> Option<Value> {
        self.fights.get(&id).map(|f| self.fight_view(f))
    }

    /// Newest first. `from` skips that many of the newest fights.
    pub fn get_fights(&self, belt_id: u32, from: u64, limit: u64) -> Vec<Value> {
        let total = self.belts.get(&belt_id).map(|b| b.fight_count).unwrap_or(0);
        let limit = limit.min(50);
        (0..limit)
            .filter_map(|i| total.checked_sub(from + i))
            .filter(|seq| *seq >= 1)
            .filter_map(|seq| self.belt_fights.get(&(belt_id, seq)).and_then(|id| self.fights.get(id)))
            .map(|f| self.fight_view(f))
            .collect()
    }

    pub fn balance_of(&self, account: AccountId) -> U128 {
        U128(self.balance(&account))
    }

    pub fn get_payout(&self, payout_id: u64) -> Option<Value> {
        self.payouts.get(&payout_id).map(|p| self.payout_view(p))
    }

    pub fn get_payouts(&self, belt: u32, season: u32) -> Vec<Value> {
        let ids = self.season_of(belt, season).map(|s| s.payouts).unwrap_or_default();
        ids.iter().filter_map(|id| self.payouts.get(id)).map(|p| self.payout_view(p)).collect()
    }

    pub fn get_evm_address(&self, account: AccountId) -> Option<String> {
        self.evm_addrs.get(&account).map(addr_hex)
    }

    /// Active allowlist, the staged one and when it can be applied.
    pub fn get_allowlist(&self) -> Value {
        json!({
            "active": addrs(&self.allowlist),
            "pending": self.pending_allowlist.as_ref().map(|(l, _)| addrs(l)),
            "activates_at": self.pending_allowlist.as_ref().map(|(_, at)| U64(*at)),
            "delay_sec": self.allowlist_delay_ns / ONE_SEC_NS,
        })
    }

    /// How one toll of this belt is shared.
    pub fn preview_split(&self, belt_id: u32) -> Value {
        let b = self.belt(belt_id);
        let s = split_toll(b.toll, b.forge_fee).unwrap_or_else(|| fail(E_FEE));
        json!({
            "toll": U128(b.toll), "forge_fee": U128(b.forge_fee), "champion": U128(s.champion), "promoter": U128(s.promoter),
            "side_pot": U128(s.side_pot), "protocol": U128(s.protocol),
        })
    }

    /// Solvency: `equity = balance - storage staking - owed` (negative = the endowment no longer pays the storage).
    /// `protocol_withdrawable` is the protocol share the owner may take out right now.
    pub fn get_solvency(&self) -> Value {
        let balance = near_sdk::env::account_balance().as_yoctonear();
        let storage = near_sdk::env::storage_usage() as u128 * STORAGE_BYTE_COST;
        let owed = self.owed();
        let deficit = self.storage_deficit();
        json!({
            "balance": U128(balance), "storage_cost": U128(storage), "storage_bytes": near_sdk::env::storage_usage(), "owed": U128(owed),
            "endowment": U128(balance.saturating_sub(storage + owed)), "deficit": U128(deficit),
            "protocol_balance": U128(self.protocol_balance), "protocol_withdrawable": U128(self.protocol_balance.saturating_sub(deficit)),
            "players_covered": deficit <= self.protocol_balance,
        })
    }

    pub fn stats(&self) -> Value {
        let s = &self.stats;
        json!({
            "tolls": U128(s.tolls), "deposits": U128(s.deposits), "withdrawn": U128(s.withdrawn), "fees_spent": U128(s.fees_spent),
            "refunded": U128(s.refunded), "protocol_total": U128(s.protocol), "protocol_balance": U128(self.protocol_balance),
            "protocol_withdrawn": U128(s.protocol_withdrawn), "challenges": s.challenges, "bouts": s.bouts, "forged": s.forged, "rejected": s.rejected, "refunds": s.refunds,
            "belts": self.belt_count, "next_challenge_id": self.next_challenge, "next_fight_id": self.next_fight,
        })
    }
}
