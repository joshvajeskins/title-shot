//! The bell, the purse plan and Chain Signatures payouts (the MPC signer is played by a test key).
use super::*;
use crate::tx::{unsigned_bytes, TxParams};
use near_sdk::PromiseResult;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub(super) fn panics<R>(f: impl FnOnce() -> R) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

pub(super) fn msg<R>(f: impl FnOnce() -> R) -> String {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => "NO PANIC".into(),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    }
}

pub(super) const PURSE: u128 = 100_000_000_000_000_000; // 0.1 ETH in wei

pub(super) fn play(e: &mut Env, n: u32) {
    for i in 0..n {
        let who = format!("fan{i}.testnet");
        e.deposit(&who, 1);
        let s = format!("season fighter {i} with an umbrella");
        let id = e.challenge(&who, &s);
        e.deliver(id, &s);
    }
}

#[test]
fn bell_refusals_too_early_pending_twice_and_the_zero_challenge_refund() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the quiet season", 3600, PURSE);
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.close_season(1)).contains("E_TOO_EARLY"));
    assert!(msg(|| e.c.close_season(7)).contains("E_NO_BELT"));
    // A challenge still forging blocks the bell until it is delivered or expires.
    e.deposit("alice.testnet", 1);
    let s = "a late forging challenge";
    let id = e.challenge("alice.testnet", s);
    e.advance(3601);
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.close_season(1)).contains("E_PENDING_BOUTS"));
    e.advance(601);
    e.at("anyone.testnet", 0);
    assert!(e.c.expire_challenge(id));
    // The only challenge was refunded: zero bouts, the whole purse goes back to the promoter.
    let ids = e.c.close_season(1);
    assert_eq!(ids.len(), 1);
    let p = e.c.get_payout(ids[0]).unwrap();
    assert_eq!(p["payee"], "vance.testnet");
    assert_eq!(p["amount_wei"], PURSE.to_string());
    assert_eq!(e.season()["state"], "Closed");
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.close_season(1)).contains("E_CLOSED"), "second close is refused: no second payout plan");
    assert_eq!(e.c.get_payouts(1, 1).as_array().unwrap().len(), 1);
    // A closed season cannot be challenged; a new one can be opened.
    e.at("alice.testnet", 0);
    assert!(msg(|| e.c.challenge(1, "after the bell has rung".into())).contains("E_NO_SEASON"));
}

#[test]
fn purse_split_conserves_wei_pays_the_side_pot_and_keeps_the_belt_with_the_holder() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the long season", 86_400, PURSE);
    play(&mut e, 14);
    let season = e.season();
    let side_pot: u128 = season["side_pot"].as_str().unwrap().parse().unwrap();
    assert!(side_pot > 0);
    let holder = e.holder();
    let holder_bal = e.bal(&holder);
    e.advance(86_400);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    assert_eq!(e.holder(), holder, "belt NFT stays with the holder");
    assert_eq!(e.bal(&holder) - holder_bal, side_pot, "side-pot credited to the final holder");
    let payouts = e.c.get_payouts(1, 1).as_array().unwrap().clone();
    assert_eq!(payouts.len(), ids.len());
    let total: u128 = payouts.iter().map(|p| p["amount_wei"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    assert_eq!(total, PURSE, "purse conserved to the wei");
    let holder_p = payouts.iter().find(|p| p["payee"] == holder.as_str()).expect("holder paid");
    assert!(holder_p["amount_wei"].as_str().unwrap().parse::<u128>().unwrap() >= PURSE / 2);
    for p in &payouts {
        if p["payee"] != holder.as_str() {
            assert!(p["amount_wei"].as_str().unwrap().parse::<u128>().unwrap() <= PURSE / 4, "pro-rata cap");
        }
    }
    // The next season can open; the old belt state carries over (champion = default opener).
    e.at("vance.testnet", 1);
    let id = e.c.open_season(1, "".into(), 3600, U128(0));
    assert_eq!(id, 2);
    assert_eq!(e.season()["state"], "Open");
    assert_eq!(e.holder(), holder, "carry-over keeps the holder");
    assert_eq!(e.season()["sealed"], true, "the new season's rule is sealed again");
}

#[test]
fn open_season_rules_promoter_only_duration_and_one_open_season_at_a_time() {
    let mut e = Env::new("relayer");
    e.at("mallory.testnet", FEE);
    assert!(msg(|| e.c.open_season(1, "Not my belt".into(), 3600, U128(0))).contains("E_NOT_PROMOTER"));
    e.at("vance.testnet", FEE);
    assert!(msg(|| e.c.open_season(1, "Too short a season".into(), 59, U128(0))).contains("E_DURATION"));
    assert!(msg(|| e.c.open_season(1, "Too long a season".into(), 30 * 86_400 + 1, U128(0))).contains("E_DURATION"));
    assert!(msg(|| e.c.open_season(1, "".into(), 3600, U128(0))).contains("E_NO_CHAMPION"), "nothing to carry over yet");
    e.at("vance.testnet", FEE - 1);
    assert!(msg(|| e.c.open_season(1, "Underpaid forge".into(), 3600, U128(0))).contains("E_FEE"));
    e.open_season("Opener of the rules", 3600, 0);
    e.at("vance.testnet", FEE);
    assert!(msg(|| e.c.open_season(1, "Second season too soon".into(), 3600, U128(0))).contains("E_SEASON_OPEN"));
}

#[test]
fn a_failed_opener_aborts_the_season_and_the_promoter_can_retry() {
    let mut e = Env::new("relayer");
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "A refused opener".into(), 3600, U128(0));
    let cid = e.c.next_challenge - 1;
    let mut v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&raw_for("A refused opener")).unwrap();
    v["verdict"] = "refused".into();
    let out = e.output("A refused opener", &v.to_string(), true, 1);
    e.at("relayer.testnet", 0);
    assert_eq!(e.c.submit_forge(cid, out), "Rejected");
    assert_eq!(e.season()["state"], "Aborted");
    e.at("vance.testnet", FEE);
    assert_eq!(e.c.open_season(1, "A polite opener".into(), 3600, U128(0)), 2);
    assert_eq!(e.season()["state"], "Opening");
    // An opener that never answers can be expired by anyone after 10 minutes.
    e.advance(601);
    e.at("anyone.testnet", 0);
    assert!(e.c.expire_challenge(e.c.next_challenge - 1));
    assert_eq!(e.season()["state"], "Aborted");
}

pub(super) fn mpc_response(sk: &k256::ecdsa::SigningKey, params: &TxParams) -> Vec<u8> {
    let digest = keccak(&unsigned_bytes(params));
    let (sig, rec) = sk.sign_prehash_recoverable(&digest).unwrap();
    let b = sig.to_bytes();
    let r = hex::encode(&b[..32]);
    let s = hex::encode(&b[32..]);
    format!(r#"{{"scheme":"Secp256k1","big_r":{{"affine_point":"03{r}"}},"s":{{"scalar":"{s}"}},"recovery_id":{}}}"#, rec.to_byte()).into_bytes()
}

pub(super) fn payout_params(e: &Env, id: u64, fee: u128, prio: u128, gas: u64, nonce: u64) -> TxParams {
    let p = e.c.payouts.get(&id).unwrap().clone();
    TxParams {
        chain_id: 84532,
        to: p.to.unwrap(),
        value: p.amount_wei - gas as u128 * fee,
        nonce,
        max_fee_per_gas: fee,
        max_priority_fee_per_gas: prio,
        gas_limit: gas,
    }
}

pub(super) fn deliver_signature(e: &mut Env, id: u64, sig: Vec<u8>) -> Option<String> {
    deliver_signature_as(e, id, sig, true)
}

pub(super) fn deliver_signature_as(e: &mut Env, id: u64, sig: Vec<u8>, by_payee: bool) -> Option<String> {
    near_sdk::test_utils::testing_env_with_promise_results(
        VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
        PromiseResult::Successful(sig),
    );
    e.c.on_signed(id, by_payee)
}

#[test]
fn payouts_sequence_nonces_resign_only_with_higher_fee_and_check_the_recovered_address() {
    let mut e = Env::new("relayer");
    let purse_key = signing_key(21);
    let purse_addr = format!("0x{}", hex::encode(eth_addr(&purse_key)));
    e.open_season("Opener of the paid season", 86_400, PURSE);
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, purse_addr.clone());
    play(&mut e, 10);
    // Fix a payout address for the holder and another payee; the rest stay unclaimed.
    let holder = e.holder();
    e.at(&holder, 1);
    e.c.set_evm_address("0x1111111111111111111111111111111111111111".into());
    e.advance(86_400);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    assert!(ids.len() >= 2, "holder plus at least one defender or promoter");
    let holder_id = *ids.iter().find(|i| e.c.payouts.get(i).unwrap().payee.as_str() == holder).unwrap();
    let other_id = *ids.iter().find(|i| **i != holder_id).unwrap();
    let gwei = 1_000_000_000u128;

    // No registered address -> E_NO_ADDRESS until the payee claims one (payee only).
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.sign_payout(other_id, U128(gwei), U128(gwei / 10), 60_000)).contains("E_NO_ADDRESS"));
    let payee = e.c.payouts.get(&other_id).unwrap().payee.to_string();
    e.at("mallory.testnet", 1);
    assert!(msg(|| e.c.claim_payout(other_id, "0x2222222222222222222222222222222222222222".into())).contains("E_NOT_PAYEE"));
    e.at(&payee, 1);
    e.c.claim_payout(other_id, "0x2222222222222222222222222222222222222222".into());
    assert!(msg(|| e.c.claim_payout(other_id, "0x3333333333333333333333333333333333333333".into())).contains("E_ALREADY"));

    // Gas bounds.
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.sign_payout(holder_id, U128(gwei), U128(0), 20_999)).contains("E_GAS"));
    assert!(msg(|| e.c.sign_payout(holder_id, U128(gwei), U128(0), 150_001)).contains("E_GAS"));
    assert!(msg(|| e.c.sign_payout(holder_id, U128(51 * gwei), U128(0), 60_000)).contains("E_GAS"));
    assert!(msg(|| e.c.sign_payout(holder_id, U128(gwei), U128(2 * gwei), 60_000)).contains("E_GAS"));
    // First payout gets nonce 0, the second nonce 1, regardless of the order of the signature callbacks.
    e.at(&holder, 0);
    let _ = e.c.sign_payout(holder_id, U128(3 * gwei), U128(gwei / 10), 60_000);
    e.at(&payee, 0);
    let _ = e.c.sign_payout(other_id, U128(3 * gwei), U128(gwei / 10), 60_000);
    assert_eq!(e.c.payouts.get(&holder_id).unwrap().nonce, Some(0));
    assert_eq!(e.c.payouts.get(&other_id).unwrap().nonce, Some(1));
    assert!(msg(|| e.c.sign_payout(holder_id, U128(3 * gwei), U128(gwei / 10), 60_000)).contains("E_SIGNING"), "request already in flight");
    assert_eq!(e.c.get_payout(holder_id).unwrap()["signing"], true);

    // A signature by the wrong key is refused (and the payout can be retried).
    let params0 = payout_params(&e, holder_id, 3 * gwei, gwei / 10, 60_000, 0);
    assert!(deliver_signature(&mut e, holder_id, mpc_response(&signing_key(22), &params0)).is_none());
    assert!(e.c.get_payout(holder_id).unwrap()["raw_tx"].is_null());
    assert_eq!(e.c.get_payout(holder_id).unwrap()["signing"], false);
    e.at(&holder, 0);
    let _ = e.c.sign_payout(holder_id, U128(3 * gwei), U128(gwei / 10), 60_000);
    assert_eq!(e.c.payouts.get(&holder_id).unwrap().nonce, Some(0), "a retry reuses the reserved nonce");
    let raw = deliver_signature(&mut e, holder_id, mpc_response(&purse_key, &params0)).expect("signed");
    assert!(raw.starts_with("0x02"));
    let v = e.c.get_payout(holder_id).unwrap();
    assert_eq!(v["raw_tx"], raw.as_str());
    assert_eq!(v["nonce"], 0);

    // Same parameters again: the stored raw tx, no new signature request.
    e.at(&holder, 0);
    match e.c.sign_payout(holder_id, U128(3 * gwei), U128(gwei / 10), 60_000) {
        near_sdk::PromiseOrValue::Value(Some(again)) => assert_eq!(again, raw),
        _ => panic!("expected the stored tx"),
    }
    // Re-sign needs a strictly higher fee, keeps the nonce, replaces the raw tx.
    assert!(msg(|| e.c.sign_payout(holder_id, U128(3 * gwei), U128(gwei / 5), 60_000)).contains("E_FEE_NOT_HIGHER"));
    assert!(msg(|| e.c.sign_payout(holder_id, U128(2 * gwei), U128(gwei / 10), 60_000)).contains("E_FEE_NOT_HIGHER"));
    let _ = e.c.sign_payout(holder_id, U128(4 * gwei), U128(gwei / 10), 60_000);
    let params1 = payout_params(&e, holder_id, 4 * gwei, gwei / 10, 60_000, 0);
    let raw2 = deliver_signature(&mut e, holder_id, mpc_response(&purse_key, &params1)).expect("re-signed");
    assert_ne!(raw2, raw);
    assert_eq!(e.c.get_payout(holder_id).unwrap()["attempt"], 2);
    assert_eq!(e.c.payouts.get(&holder_id).unwrap().nonce, Some(0));
    // A failed re-sign leaves the previous signed tx in place.
    e.at(&holder, 0);
    let _ = e.c.sign_payout(holder_id, U128(5 * gwei), U128(gwei / 10), 60_000);
    near_sdk::test_utils::testing_env_with_promise_results(
        VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
        PromiseResult::Failed,
    );
    assert!(e.c.on_signed(holder_id, false).is_none());
    assert_eq!(e.c.get_payout(holder_id).unwrap()["raw_tx"], raw2.as_str());
    // A lost callback can be reset after 10 minutes.
    e.at(&holder, 0);
    let _ = e.c.sign_payout(holder_id, U128(5 * gwei), U128(gwei / 10), 60_000);
    assert!(msg(|| e.c.reset_payout_signing(holder_id)).contains("E_TOO_EARLY"));
    e.advance(601);
    e.at("anyone.testnet", 0);
    e.c.reset_payout_signing(holder_id);
    assert!(msg(|| e.c.reset_payout_signing(holder_id)).contains("E_NOT_SIGNING"));
    // The purse address is frozen once nonces are in use.
    e.at("vance.testnet", 1);
    assert!(msg(|| e.c.set_purse_address(1, 1, purse_addr.clone())).contains("E_ALREADY"));
    assert!(panics(|| e.c.sign_payout(9999, U128(gwei), U128(0), 60_000)));
}

#[test]
fn payout_smaller_than_its_gas_is_dust_and_a_cached_opener_opens_without_a_forge() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the dust season", 60, 1_000_000_000_000); // 1e12 wei purse
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, "0x4444444444444444444444444444444444444444".into());
    e.at("vance.testnet", 1);
    e.c.set_evm_address("0x5555555555555555555555555555555555555555".into());
    e.advance(61);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    e.at("vance.testnet", 0); // the payee: a stranger is clamped to a 1% burn and could never hit dust

    // No bouts: the promoter gets the purse back, but the gas of even the cheapest tx exceeds it.
    assert!(msg(|| e.c.sign_payout(ids[0], U128(1_000_000_000), U128(0), 21_000)).contains("E_DUST"));
    // Season 2 with the same (now cached) opener sentence opens at once: no challenge id is consumed.
    let next = e.c.next_challenge;
    e.at("vance.testnet", 1);
    assert_eq!(e.c.open_season(1, "  Opener of the dust   season ".into(), 3600, U128(0)), 2);
    assert_eq!(e.c.next_challenge, next, "no forge was requested");
    assert_eq!(e.season()["state"], "Open");
    assert_eq!(e.holder(), "vance.testnet");
}
