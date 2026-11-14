//! Fixes from the adversarial review: stranger gas burn is clamped, the purse is capped, the purse address stays
//! correctable until a payout really signs, and the owner's protocol share absorbs a storage deficit first.
use super::season_tests::{deliver_signature_as, mpc_response, msg, payout_params, play, PURSE};
use super::*;
use crate::economy::{clamp_stranger_fee, MAX_PURSE_WEI};
use near_sdk::PromiseOrValue;

const GWEI: u128 = 1_000_000_000;

/// A closed season whose purse address is `purse_addr`; returns (holder account, holder payout id).
fn closed_season(e: &mut Env, purse_addr: &str) -> (String, u64) {
    e.open_season("Opener of the review season", 86_400, PURSE);
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, purse_addr.to_string());
    play(e, 6);
    let holder = e.holder();
    e.at(&holder, 1);
    e.c.set_evm_address("0x1111111111111111111111111111111111111111".into());
    e.advance(86_400);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    let id = *ids.iter().find(|i| e.c.payouts.get(i).unwrap().payee.as_str() == holder).unwrap();
    (holder, id)
}

#[test]
fn a_stranger_can_never_burn_more_than_one_percent_of_a_payout_and_the_payee_always_has_the_last_word() {
    let mut e = Env::new("relayer");
    let key = signing_key(31);
    let addr = format!("0x{}", hex::encode(eth_addr(&key)));
    let (holder, id) = closed_season(&mut e, &addr);
    let amount = e.c.payouts.get(&id).unwrap().amount_wei;
    // The stranger asks for the most expensive tx the bounds allow.
    e.at("mallory.testnet", 0);
    let _ = e.c.sign_payout(id, U128(50 * GWEI), U128(50 * GWEI), 150_000);
    let (fee, prio) = clamp_stranger_fee(amount, 150_000, 50 * GWEI, 50 * GWEI);
    assert!(150_000 * fee <= amount / 100, "burn {} of {}", 150_000 * fee, amount);
    assert!(prio <= fee);
    let params = payout_params(&e, id, fee, prio, 150_000, 0);
    assert!(deliver_signature_as(&mut e, id, mpc_response(&key, &params), false).is_some());
    let v = e.c.get_payout(id).unwrap();
    assert!(v["value_wei"].as_str().unwrap().parse::<u128>().unwrap() * 100 >= amount * 99);
    // The stranger cannot sign it again with other parameters, but the payee replaces it with any (even lower) fee.
    e.at(&holder, 0);
    let low = fee / 2;
    let _ = e.c.sign_payout(id, U128(low), U128(0), 21_000);
    let params2 = payout_params(&e, id, low, 0, 21_000, 0);
    assert!(deliver_signature_as(&mut e, id, mpc_response(&key, &params2), true).is_some(), "payee replaced the stranger's tx");
    assert_eq!(e.c.get_payout(id).unwrap()["attempt"], 2);
    // Now the payee's choice stands: a stranger asking for anything else is refused, the same params return it.
    e.at("mallory.testnet", 0);
    assert!(msg(|| e.c.sign_payout(id, U128(GWEI), U128(0), 60_000)).contains("E_NOT_PAYEE"));
    // And the payee needs a strictly higher fee to replace their own tx.
    e.at(&holder, 0);
    assert!(msg(|| e.c.sign_payout(id, U128(low), U128(0), 60_000)).contains("E_FEE_NOT_HIGHER"));
    assert!(matches!(e.c.sign_payout(id, U128(low), U128(0), 21_000), PromiseOrValue::Value(Some(_))), "same params: stored tx");
}

#[test]
fn clamp_never_exceeds_one_percent_and_never_touches_cheap_requests() {
    for amount in [1u128, 21_000, 2_100_000, 10u128.pow(15), 7_500_000_000_000_000, u128::MAX / 4] {
        for gas in [21_000u64, 60_000, 150_000] {
            for fee in [1u128, GWEI, 50 * GWEI] {
                let (f, p) = clamp_stranger_fee(amount, gas, fee, fee);
                assert!(f >= 1 && f <= fee && p <= f);
                // above 1 wei the burn is within 1%; at 1 wei the payout is dust-sized and the sign is refused anyway
                assert!(f == 1 || gas as u128 * f <= amount / 100, "amount {amount} gas {gas} fee {fee} -> {f}");
                if gas as u128 * fee <= amount / 100 {
                    assert_eq!((f, p), (fee, fee), "a request already inside the cap is untouched");
                }
            }
        }
    }
}

#[test]
fn purse_is_capped_so_the_bell_can_always_ring() {
    let mut e = Env::new("relayer");
    e.at("vance.testnet", FEE);
    assert!(msg(|| e.c.open_season(1, "A purse too large to split".into(), 3600, U128(MAX_PURSE_WEI + 1))).contains("E_AMOUNT"));
    assert!(msg(|| e.c.open_season(1, "A purse too large to split".into(), 3600, U128(u128::MAX))).contains("E_AMOUNT"));
    // The cap itself is accepted and the bell rings (no u128 overflow in the plan) with several defenders.
    e.open_season("An opener worth a king's ransom", 3600, MAX_PURSE_WEI);
    play(&mut e, 5);
    e.advance(3601);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    let total: u128 = ids.iter().map(|i| e.c.payouts.get(i).unwrap().amount_wei).sum();
    assert_eq!(total, MAX_PURSE_WEI, "the plan still sums to the purse exactly");
}

#[test]
fn a_wrong_purse_address_is_correctable_after_a_failed_signature_and_frozen_once_a_payout_signs() {
    let mut e = Env::new("relayer");
    let key = signing_key(32);
    let right = format!("0x{}", hex::encode(eth_addr(&key)));
    let (holder, id) = closed_season(&mut e, "0x4444444444444444444444444444444444444444");
    e.at(&holder, 0);
    let _ = e.c.sign_payout(id, U128(2 * GWEI), U128(GWEI / 10), 60_000);
    // Signing in flight: the address cannot move under it.
    e.at("vance.testnet", 1);
    assert!(msg(|| e.c.set_purse_address(1, 1, right.clone())).contains("E_ALREADY"));
    // The signer answers with the right key, but the stored address is wrong: refused, nothing stored.
    let params = payout_params(&e, id, 2 * GWEI, GWEI / 10, 60_000, 0);
    assert!(deliver_signature_as(&mut e, id, mpc_response(&key, &params), true).is_none());
    assert_eq!(e.c.get_payout(id).unwrap()["signing"], false);
    assert!(e.c.payouts.get(&id).unwrap().nonce.is_some(), "the nonce was taken by the failed attempt");
    // The promoter corrects the address (a failed attempt must not freeze it) and the retry signs.
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, right.clone());
    e.at(&holder, 0);
    let _ = e.c.sign_payout(id, U128(2 * GWEI), U128(GWEI / 10), 60_000);
    let params = payout_params(&e, id, 2 * GWEI, GWEI / 10, 60_000, 0);
    assert!(deliver_signature_as(&mut e, id, mpc_response(&key, &params), true).is_some());
    // A signed payout freezes the address for good.
    e.at("vance.testnet", 1);
    assert!(msg(|| e.c.set_purse_address(1, 1, "0x5555555555555555555555555555555555555555".into())).contains("E_ALREADY"));
}

#[test]
fn protocol_share_leaves_only_beyond_the_storage_deficit_and_never_player_money() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the solvency season", 3600, PURSE);
    play(&mut e, 4);
    e.at("titleshot.testnet", 0);
    let sol = e.c.get_solvency();
    let prot: u128 = sol["protocol_balance"].as_str().unwrap().parse().unwrap();
    assert!(prot > 0);
    assert_eq!(sol["protocol_withdrawable"], sol["protocol_balance"], "an endowed contract frees the whole protocol share");
    // Drain the mocked account balance to the owed amount only: the storage is now unpaid, the protocol share pays it.
    let owed: u128 = sol["owed"].as_str().unwrap().parse().unwrap();
    let storage: u128 = sol["storage_cost"].as_str().unwrap().parse().unwrap();
    let balance = owed + storage - prot / 2; // short by half the protocol share
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct("titleshot.testnet"))
        .predecessor_account_id(acct("titleshot.testnet"))
        .account_balance(NearToken::from_yoctonear(balance))
        .attached_deposit(NearToken::from_yoctonear(1))
        .storage_usage(storage_bytes(&sol))
        .block_timestamp(e.t * 1_000_000_000)
        .build());
    let sol2 = e.c.get_solvency();
    let deficit: u128 = sol2["deficit"].as_str().unwrap().parse().unwrap();
    assert!(deficit.abs_diff(prot / 2) <= 1, "the 1 yocto attached to a call counts as balance");
    assert!(sol2["protocol_withdrawable"].as_str().unwrap().parse::<u128>().unwrap().abs_diff(prot - prot / 2) <= 1);
    assert!(msg(|| e.c.withdraw_protocol(acct("titleshot.testnet"), Some(U128(prot)))).contains("E_BALANCE"), "more than the free part is refused");
}

fn storage_bytes(sol: &Value) -> u64 {
    sol["storage_bytes"].as_u64().unwrap()
}
