//! Belt token: a minimal NEP-171 core (no approvals, no `nft_transfer_call`) with metadata and enumeration, hand
//! written because `near-contract-standards` cost about 45 KB of wasm (one NEAR of storage per 100 KB).
//! One token per belt, `belt-{id}`. The NFT owner IS the belt holder: `nft_transfer` (1 yocto, holder only)
//! gifts or sells a title. Metadata is derived from the belt (name, media) so there is nothing extra to store.
use crate::codes::*;
use crate::json::{arr, json, Null, Raw};
use crate::util::token_id;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

const NEP171: &str = "nep171";
const NEP171_VERSION: &str = "1.2.0";
const DESCRIPTION: &str = "A TITLE SHOT+ championship belt. Whoever holds it is paid every time the belt is challenged.";

fn emit171(event: &str, data: Raw) {
    let body = json!({ "standard": NEP171, "version": NEP171_VERSION, "event": event, "data": arr([data]) });
    env::log_str(&format!("EVENT_JSON:{}", body.0));
}

/// `belt-{id}` -> id.
fn belt_of(token: &str) -> Option<u32> {
    token.strip_prefix("belt-")?.parse().ok().filter(|id| token_id(*id) == token)
}

impl Contract {
    fn token_view(&self, belt_id: u32) -> Option<Raw> {
        let owner = self.holders.get(&belt_id)?;
        let belt = self.belts.get(&belt_id)?;
        let media = if belt.media.is_empty() { None } else { Some(belt.media.clone()) };
        let meta = json!({ "title": belt.name, "description": DESCRIPTION, "media": media });
        Some(json!({ "token_id": token_id(belt_id), "owner_id": owner, "metadata": meta, "approved_account_ids": Null }))
    }

    /// Mint `belt-{id}` to `to` (the contract pays the storage).
    pub fn mint_belt(&mut self, belt_id: u32, to: &AccountId) {
        self.holders.insert(belt_id, to.clone());
        emit171("nft_mint", json!({ "owner_id": to, "token_ids": arr([token_id(belt_id)]) }));
    }

    /// Internal transfer of the belt token (callers decide who may).
    pub fn move_belt(&mut self, belt_id: u32, from: &AccountId, to: &AccountId) {
        if from == to {
            return;
        }
        self.holders.insert(belt_id, to.clone());
        emit171(
            "nft_transfer",
            json!({ "old_owner_id": from, "new_owner_id": to, "token_ids": arr([token_id(belt_id)]), "memo": "titleshot" }),
        );
    }
}

#[near]
impl Contract {
    /// NEP-171 transfer by the holder, 1 yocto (a function-call key can never call it). Approvals are not supported.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        check(approval_id.is_none(), E_CONFIG);
        let belt_id = belt_of(&token_id).unwrap_or_else(|| fail(E_NO_BELT));
        let from = self.holder(belt_id);
        check(from == env::predecessor_account_id(), E_NOT_HOLDER);
        check(from != receiver_id, E_SELF);
        self.holders.insert(belt_id, receiver_id.clone());
        emit171(
            "nft_transfer",
            json!({ "old_owner_id": from, "new_owner_id": receiver_id, "token_ids": arr([token_id]), "memo": memo }),
        );
    }

    pub fn nft_token(&self, token_id: String) -> Option<Raw> {
        self.token_view(belt_of(&token_id)?)
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.belt_count as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Raw {
        let skip = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let take = limit.unwrap_or(50).min(50) as usize;
        let tokens: Vec<Raw> = (1..=self.belt_count)
            .filter(|id| self.holders.get(id).as_ref() == Some(&account_id))
            .skip(skip)
            .take(take)
            .filter_map(|id| self.token_view(id))
            .collect();
        arr(tokens)
    }

    pub fn nft_metadata(&self) -> Raw {
        json!({
            "spec": "nft-1.0.0", "name": "TITLE SHOT+ belts", "symbol": "BELT", "icon": Null, "base_uri": Null,
            "reference": Null, "reference_hash": Null,
        })
    }
}
