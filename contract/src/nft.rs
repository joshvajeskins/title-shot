//! Belt token (NEP-171 + metadata + enumeration). One token per belt, `belt-{id}`. The NFT owner IS the
//! belt holder: `nft_transfer` (1 yocto, holder only) gifts or sells a title.
use crate::util::token_id;
use crate::{Contract, ContractExt};
use near_contract_standards::non_fungible_token::events::{NftMint, NftTransfer};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_contract_standards::{impl_non_fungible_token_core, impl_non_fungible_token_enumeration};
use near_sdk::{near, AccountId, PromiseOrValue};

impl_non_fungible_token_core!(Contract, tokens);
impl_non_fungible_token_enumeration!(Contract, tokens);

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "TITLE SHOT+ belts".to_string(),
            symbol: "BELT".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}

fn belt_metadata(name: &str, media: &str) -> TokenMetadata {
    TokenMetadata {
        title: Some(name.to_string()),
        description: Some("A TITLE SHOT+ championship belt. Whoever holds it is paid every time the belt is challenged.".into()),
        media: if media.is_empty() { None } else { Some(media.to_string()) },
        ..Default::default()
    }
}

impl Contract {
    /// Mint `belt-{id}` to `to` (contract pays the storage; no refund bookkeeping).
    pub fn mint_belt(&mut self, belt_id: u32, name: &str, media: &str, to: &AccountId) {
        let id = token_id(belt_id);
        self.tokens.internal_mint_with_refund(id.clone(), to.clone(), Some(belt_metadata(name, media)), None);
        NftMint { owner_id: to, token_ids: &[&id], memo: None }.emit();
    }

    /// Internal transfer of the belt token (no approval check; callers decide).
    pub fn move_belt(&mut self, belt_id: u32, from: &AccountId, to: &AccountId) {
        if from == to {
            return;
        }
        let id: TokenId = token_id(belt_id);
        self.tokens.internal_transfer_unguarded(&id, from, to);
        NftTransfer {
            old_owner_id: from,
            new_owner_id: to,
            token_ids: &[&id],
            authorized_id: None,
            memo: Some("titleshot"),
        }
        .emit();
    }

    pub fn set_belt_token_media(&mut self, belt_id: u32, name: &str, media: &str) {
        let id = token_id(belt_id);
        if let Some(m) = self.tokens.token_metadata_by_id.as_mut() {
            m.insert(&id, &belt_metadata(name, media));
        }
    }
}
