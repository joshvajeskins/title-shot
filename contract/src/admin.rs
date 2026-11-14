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

    #[payable]
    pub fn set_forge_mode(&mut self, mode: String) {
        assert_one_yocto();
        self.assert_owner();
        self.forge_mode = ForgeMode::parse(&mode).unwrap_or_else(|| fail(E_CONFIG));
        emit("forge_mode", json!({ "mode": mode }));
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

    /// Change the compile request (model, prefix/suffix bytes, signature kind). Existing fighters keep
    /// their stored specs. Emits the new hashes so the change is visible.
    #[payable]
    pub fn set_request(&mut self, model_id: String, req_prefix: B64, req_suffix: B64, signature_kind: String) {
        assert_one_yocto();
        self.assert_owner();
        check_request(&model_id, &req_prefix.0, &req_suffix.0, &signature_kind);
        self.model_id = model_id;
        self.req_prefix = req_prefix.0;
        self.req_suffix = req_suffix.0;
        self.gateway_kind = signature_kind == "gateway";
        emit(
            "request_changed",
            json!({
                "model_id": self.model_id,
                "prefix_sha256": crate::hex::encode(env::sha256_array(&self.req_prefix)),
                "suffix_sha256": crate::hex::encode(env::sha256_array(&self.req_suffix)),
                "signature_kind": signature_kind,
            }),
        );
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
