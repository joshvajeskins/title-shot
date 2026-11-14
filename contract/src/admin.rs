//! Init and owner-only configuration. Every setter takes 1 yocto, so a function-call key can never call it.
use crate::codes::*;
use crate::economy::MAX_TOLL;
use crate::events::emit;
use crate::types::*;
use crate::util::*;
use crate::verify::{self, Kind};
use crate::{Contract, ContractExt, Key};
use crate::b64::B64;
use near_sdk::json_types::U128;
use crate::json::json;
use crate::store::Map;
use near_sdk::{assert_one_yocto, env, near, AccountId, NearToken, Promise};

const MAX_DELAY_SEC: u64 = 30 * 24 * 3600;

fn parse_list(addrs: &[String]) -> Vec<Addr> {
    check(!addrs.is_empty() && addrs.len() <= 8, E_CONFIG);
    addrs.iter().map(|a| parse_addr(a)).collect()
}

fn check_request(model_id: &str, prefix: &[u8], suffix: &[u8], kind: &str) {
    check(!model_id.is_empty() && model_id.len() <= 128, E_CONFIG);
    check(!prefix.is_empty() && !suffix.is_empty(), E_CONFIG);
    check(Kind::parse(kind).is_some(), E_CONFIG);
}

impl Contract {
    /// The staged change to add to (a new proposal restarts the timelock for everything staged).
    fn stage_config(&self) -> PendingConfig {
        self.pending_config.clone().unwrap_or(PendingConfig { request: None, mode: None, activates_at: 0 })
    }

    fn propose_config(&mut self, mut p: PendingConfig) {
        p.activates_at = now() + self.allowlist_delay_ns;
        let req = p.request.as_ref().map(|r| self.request_json(&r.model_id, &r.prefix, &r.suffix, r.gateway));
        emit("config_proposed", json!({ "request": req, "forge_mode": p.mode.map(|m| m.name()), "activates_at": p.activates_at.to_string() }));
        let now_ok = self.allowlist_delay_ns == 0 && (p.request.is_none() || self.stats.forging == 0);
        self.pending_config = Some(p);
        if now_ok {
            self.apply_config();
        }
    }

    pub fn request_json(&self, model_id: &str, prefix: &[u8], suffix: &[u8], gateway: bool) -> crate::json::Raw {
        json!({
            "model_id": model_id,
            "prefix_sha256": crate::hex::encode(env::sha256_array(prefix)),
            "suffix_sha256": crate::hex::encode(env::sha256_array(suffix)),
            "signature_kind": if gateway { "gateway" } else { "provider_tee" },
        })
    }
}

#[near]
impl Contract {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        outlayer: AccountId,
        forge_project: String,
        mpc_signer: AccountId,
        model_id: String,
        req_prefix: B64,
        req_suffix: B64,
        signature_kind: String,
        signer_allowlist: Vec<String>,
        forge_mode: String,
        allowlist_delay_sec: u64,
    ) -> Self {
        check_request(&model_id, &req_prefix.0, &req_suffix.0, &signature_kind);
        check(allowlist_delay_sec <= MAX_DELAY_SEC && !forge_project.is_empty(), E_CONFIG);
        let mode = ForgeMode::parse(&forge_mode).unwrap_or_else(|| fail(E_CONFIG));
        let allowlist = parse_list(&signer_allowlist);
        Self {
            holders: Map::new(Key::NftOwner),
            owner,
            outlayer,
            forge_project,
            mpc_signer,
            model_id,
            req_prefix: req_prefix.0,
            req_suffix: req_suffix.0,
            gateway_kind: signature_kind == "gateway",
            allowlist,
            pending_allowlist: None,
            allowlist_delay_ns: allowlist_delay_sec * ONE_SEC_NS,
            forge_mode: mode,
            pending_config: None,
            relayers: vec![],
            vrf_pubkey: None,
            secrets: None,
            balances: Map::new(Key::Balances),
            protocol_balance: 0,
            belts: Map::new(Key::Belts),
            belt_count: 0,
            seasons: Map::new(Key::Seasons),
            fighters: Map::new(Key::Fighters),
            challenges: Map::new(Key::Challenges),
            next_challenge: 1,
            pending: Map::new(Key::Pending),
            fights: Map::new(Key::Fights),
            next_fight: 1,
            belt_fights: Map::new(Key::BeltFights),
            payouts: Map::new(Key::Payouts),
            next_payout: 1,
            evm_addrs: Map::new(Key::EvmAddrs),
            stats: Stats::default(),
        }
    }

    /// Stage a new signer allowlist; it activates `allowlist_delay_sec` later via `apply_allowlist`.
    #[payable]
    pub fn propose_allowlist(&mut self, addrs: Vec<String>) {
        assert_one_yocto();
        self.assert_owner();
        let list = parse_list(&addrs);
        let at = now() + self.allowlist_delay_ns;
        self.pending_allowlist = Some((list, at));
        emit("allowlist_proposed", json!({ "addrs": addrs, "activates_at": at.to_string() }));
    }

    /// Anyone, once the timelock has passed.
    pub fn apply_allowlist(&mut self) {
        let (list, at) = self.pending_allowlist.clone().unwrap_or_else(|| fail(E_TIMELOCK));
        check(now() >= at, E_TIMELOCK);
        self.allowlist = list;
        self.pending_allowlist = None;
        let addrs: Vec<String> = self.allowlist.iter().map(verify::addr_hex).collect();
        emit("allowlist_applied", json!({ "addrs": addrs }));
    }

    /// Staged behind the allowlist timelock (`apply_config`); with a zero delay it applies at once. Challenges already
    /// forging keep the mode they were created in.
    #[payable]
    pub fn set_forge_mode(&mut self, mode: String) {
        assert_one_yocto();
        self.assert_owner();
        let m = ForgeMode::parse(&mode).unwrap_or_else(|| fail(E_CONFIG));
        let mut p = self.stage_config();
        p.mode = Some(m);
        self.propose_config(p);
    }

    /// Anyone, once the timelock has passed. A request change also waits until no challenge is forging
    /// (`E_PENDING_BOUTS`), so no compile in flight is checked against bytes it was not sent with.
    pub fn apply_config(&mut self) {
        let p = self.pending_config.clone().unwrap_or_else(|| fail(E_TIMELOCK));
        check(now() >= p.activates_at, E_TIMELOCK);
        check(p.request.is_none() || self.stats.forging == 0, E_PENDING_BOUTS);
        self.pending_config = None;
        if let Some(m) = p.mode {
            self.forge_mode = m;
            emit("forge_mode", json!({ "mode": m.name() }));
        }
        if let Some(r) = p.request {
            self.model_id = r.model_id;
            self.req_prefix = r.prefix;
            self.req_suffix = r.suffix;
            self.gateway_kind = r.gateway;
            emit("request_changed", self.request_json(&self.model_id, &self.req_prefix, &self.req_suffix, r.gateway));
        }
    }

    #[payable]
    pub fn add_relayer(&mut self, acct: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        if !self.relayers.contains(&acct) {
            check(self.relayers.len() < 16, E_CONFIG);
            self.relayers.push(acct);
        }
    }

    #[payable]
    pub fn remove_relayer(&mut self, acct: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.relayers.retain(|a| a != &acct);
    }

    /// Pin the OutLayer VRF key (hex ed25519); the callback then verifies every VRF proof. `""` clears.
    #[payable]
    pub fn set_vrf_pubkey(&mut self, pubkey_hex: String) {
        assert_one_yocto();
        self.assert_owner();
        self.vrf_pubkey = if pubkey_hex.is_empty() {
            None
        } else {
            let mut k = [0u8; 32];
            crate::hex::decode_to_slice(pubkey_hex.trim_start_matches("0x"), &mut k).unwrap_or_else(|_| fail(E_CONFIG));
            Some(k)
        };
    }

    /// OutLayer secrets reference (profile holding NEARAI_API_KEY and its owner). Empty profile clears.
    #[payable]
    pub fn set_forge_secrets(&mut self, profile: String, owner: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.secrets = if profile.is_empty() { None } else { Some((profile, owner)) };
    }

    /// Change the compile request (model, prefix/suffix bytes, signature kind). Staged behind the allowlist timelock and
    /// applied by `apply_config` (at once when the delay is zero and nothing is forging). Existing fighters keep their
    /// stored specs. The staged hashes are published (`config_proposed`, `get_config.pending_config`).
    #[payable]
    pub fn set_request(&mut self, model_id: String, req_prefix: B64, req_suffix: B64, signature_kind: String) {
        assert_one_yocto();
        self.assert_owner();
        check_request(&model_id, &req_prefix.0, &req_suffix.0, &signature_kind);
        let mut p = self.stage_config();
        p.request = Some(RequestParts { model_id, prefix: req_prefix.0, suffix: req_suffix.0, gateway: signature_kind == "gateway" });
        self.propose_config(p);
    }

    /// Creates the belt and mints its NFT to the promoter. Ids start at 1.
    #[payable]
    pub fn create_belt(
        &mut self,
        name: String,
        promoter: AccountId,
        toll: U128,
        forge_fee: U128,
        purse_chain_id: u64,
    ) -> u32 {
        assert_one_yocto();
        self.assert_owner();
        let n = name.chars().count();
        check((1..=48).contains(&n) && purse_chain_id > 0, E_CONFIG);
        check(forge_fee.0 >= MIN_FORGE_FEE && forge_fee.0 < toll.0 && toll.0 <= MAX_TOLL, E_FEE);
        self.belt_count += 1;
        let id = self.belt_count;
        self.belts.insert(
            id,
            Belt {
                name: name.clone(),
                promoter: promoter.clone(),
                toll: toll.0,
                forge_fee: forge_fee.0,
                purse_chain_id,
                season: 0,
                champion: None,
                reign_since: 0,
                defences: 0,
                fight_count: 0,
                media: String::new(),
            },
        );
        self.mint_belt(id, &promoter);
        emit("belt_created", json!({ "belt_id": id, "name": name, "promoter": promoter, "toll": toll, "forge_fee": forge_fee }));
        id
    }

    #[payable]
    pub fn set_belt_media(&mut self, belt_id: u32, media: String) {
        assert_one_yocto();
        self.assert_owner();
        check(media.len() <= 512, E_CONFIG);
        let mut belt = self.belt(belt_id);
        belt.media = media.clone();
        self.belts.insert(belt_id, belt);
    }

    /// Owner pays out the protocol share (it funds the promoter NPC).
    #[payable]
    pub fn withdraw_protocol(&mut self, to: AccountId, amount: Option<U128>) -> U128 {
        assert_one_yocto();
        self.assert_owner();
        // Storage that the endowment cannot pay is paid from the protocol share first: players' money is never touched.
        let withdrawable = self.protocol_balance.saturating_sub(self.storage_deficit());
        let amt = amount.map(|a| a.0).unwrap_or(withdrawable);
        check(amt > 0 && amt <= withdrawable, E_BALANCE);
        self.protocol_balance -= amt;
        self.stats.protocol_withdrawn += amt;
        Promise::new(to).transfer(NearToken::from_yoctonear(amt));
        U128(amt)
    }
}
