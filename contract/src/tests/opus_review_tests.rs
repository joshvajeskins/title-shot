//! Opus review (one round). Each test FAILS on the reviewed contract and must turn green with the fix.
//! HIGH: a payee can hold every later payout of a season hostage with an unmineable fee (sequential purse nonces, and a
//! stranger can never replace a payee-signed tx). MEDIUM: opener forge fees are subtracted from `owed()` although they
//! never entered `deposits`, so the solvency view understates what players are owed and frees player money as protocol share.
use super::season_tests::{msg, play, PURSE};
use super::*;
use crate::tx::TxParams;
use near_sdk::test_utils::testing_env_with_promise_results;
use near_sdk::PromiseResult;

const GWEI: u128 = 1_000_000_000;

fn evm(n: u8) -> String {
    format!("0x{}", hex::encode([n; 20]))
}

/// The MPC signer answers the request that is in flight for payout `id` (params read back from the contract).
fn answer_in_flight(e: &mut Env, key: &k256::ecdsa::SigningKey, id: u64, by_payee: bool) -> Option<String> {
    let (params, _): (TxParams, u64) = e.c.payouts.get(&id).unwrap().signing.clone().expect("a signing request is in flight");
    testing_env_with_promise_results(
        VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
        PromiseResult::Successful(super::season_tests::mpc_response(key, &params)),
    );
    e.c.on_signed(id, by_payee)
}

fn sign_as(e: &mut Env, who: &str, id: u64, fee: u128, prio: u128, gas: u64) -> String {
    e.at(who, 0);
    msg(|| e.c.sign_payout(id, U128(fee), U128(prio), gas))
}

#[test]
fn a_payee_cannot_hold_the_other_payouts_of_a_season_hostage_with_an_unmineable_fee() {
    let mut e = Env::new("relayer");
    let key = signing_key(41);
    let purse_addr = format!("0x{}", hex::encode(eth_addr(&key)));
    e.open_season("Opener of the hostage season", 86_400, PURSE);
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, purse_addr);
    play(&mut e, 6);
    // Every possible payee registers an EVM address before the bell.
    let mut who: Vec<String> = (0..6).map(|i| format!("fan{i}.testnet")).collect();
    who.push("vance.testnet".into());
    for (i, a) in who.iter().enumerate() {
        e.at(a, 1);
        e.c.set_evm_address(evm(0x10 + i as u8));
    }
    e.advance(86_400);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    assert!(ids.len() >= 2, "need a holder payout and at least one defender payout: {ids:?}");
    // The griefer is a defender (not the final holder). In one tx (close_season + sign_payout) it always gets nonce 0.
    let grief_id = ids[1];
    let griefer = e.c.payouts.get(&grief_id).unwrap().payee.to_string();
    let r = sign_as(&mut e, &griefer, grief_id, 1, 0, 21_000);
    if r != "NO PANIC" {
        return; // fixed by refusing an unmineable payee fee
    }
    assert!(answer_in_flight(&mut e, &key, grief_id, true).is_some(), "the 1-wei tx is signed and stored");
    assert_eq!(e.c.payouts.get(&grief_id).unwrap().nonce, Some(0));
    // The holder's payout (at least half the purse) now sits behind nonce 0, which can never be mined at 1 wei.
    let holder_id = ids[0];
    let holder = e.c.payouts.get(&holder_id).unwrap().payee.to_string();
    assert_eq!(sign_as(&mut e, &holder, holder_id, 2 * GWEI, GWEI / 10, 21_000), "NO PANIC");
    assert!(answer_in_flight(&mut e, &key, holder_id, true).is_some());
    assert_eq!(e.c.payouts.get(&holder_id).unwrap().nonce, Some(1));
    // A day later the bell worker (a stranger) must be able to unstick nonce 0 at a market fee (within the 1% rule).
    e.advance(86_400);
    let r = sign_as(&mut e, "bell.testnet", grief_id, 2 * GWEI, GWEI / 10, 21_000);
    assert_eq!(r, "NO PANIC", "a payee-signed 1-wei tx at the lowest nonce blocks every later payout of the season forever");
    assert!(answer_in_flight(&mut e, &key, grief_id, false).is_some());
    let st = e.c.payouts.get(&grief_id).unwrap().signed.unwrap();
    assert!(st.params.max_fee_per_gas > 1 && st.params.nonce == 0, "nonce 0 re-signed at a mineable fee");
}

#[test]
fn opener_fees_never_make_owed_smaller_than_what_the_contract_holds_for_players() {
    let mut e = Env::new("relayer");
    // The promoter attaches the opener's forge fee directly (it never entered `deposits`).
    e.open_season("Opener paid by the promoter", 3600, PURSE);
    e.at("titleshot.testnet", 1);
    let prot = e.c.protocol_balance;
    assert_eq!(prot, FEE, "relayer mode: the opener fee is protocol share");
    e.c.withdraw_protocol(acct("titleshot.testnet"), Some(U128(prot)));
    e.deposit("alice.testnet", 1);
    let held = e.bal("alice.testnet") + e.c.protocol_balance;
    assert!(
        e.c.owed() >= held,
        "owed {} < player balances + protocol {}: the opener fee was subtracted from deposits it never entered",
        e.c.owed(),
        held
    );
    // Outlayer mode: the opener fee is counted in `fees_spent`, which `owed()` subtracts from deposits.
    let mut o = Env::new("outlayer");
    o.at("vance.testnet", FEE);
    o.c.open_season(1, "Opener forged by OutLayer".into(), 3600, U128(PURSE));
    o.deposit("bob.testnet", 1);
    assert!(o.c.owed() >= o.bal("bob.testnet"), "owed {} < bob's balance {}", o.c.owed(), o.bal("bob.testnet"));
}
