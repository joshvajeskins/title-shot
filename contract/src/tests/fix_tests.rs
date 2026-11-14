//! Fixes for the Opus review: payout liveness (payee fee floor, grace-period replacement that re-signing never restarts,
//! dust folded into the holder), the in-flight payee flag, opener fees as inflow, failed challenges paying their storage,
//! the request/forge-mode timelock and the VRF sender binding.
use super::season_tests::{deliver_signature_as, mpc_response, msg, play, PURSE};
use super::*;
use crate::economy::{fold_dust, plan_purse, MIN_PAYEE_FEE_PER_GAS, MIN_PAYOUT_WEI};
use crate::tx::TxParams;

const GWEI: u128 = 1_000_000_000;

/// The MPC signer answers the request in flight for payout `id`; `claimed` is what the callback arguments say.
fn answer(e: &mut Env, key: &k256::ecdsa::SigningKey, id: u64, claimed: bool) -> Option<String> {
    let (params, _): (TxParams, u64) = e.c.payouts.get(&id).unwrap().signing.clone().expect("a request in flight");
    deliver_signature_as(e, id, mpc_response(key, &params), claimed)
}

fn sign(e: &mut Env, who: &str, id: u64, fee: u128) -> String {
    e.at(who, 0);
    msg(|| e.c.sign_payout(id, U128(fee), U128(0), 21_000))
}

/// A closed season with every payee's EVM address registered; returns (purse key, payout ids).
fn bell(e: &mut Env, key_n: u8) -> (k256::ecdsa::SigningKey, Vec<u64>) {
    let key = signing_key(key_n);
    e.open_season("Opener of the liveness season", 86_400, PURSE);
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, format!("0x{}", hex::encode(eth_addr(&key))));
    play(e, 6);
    let mut who: Vec<String> = (0..6).map(|i| format!("fan{i}.testnet")).collect();
    who.push("vance.testnet".into());
    for (i, a) in who.iter().enumerate() {
        e.at(a, 1);
        e.c.set_evm_address(format!("0x{}", hex::encode([0x20 + i as u8; 20])));
    }
    e.advance(86_400);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    assert!(ids.len() >= 2, "{ids:?}");
    (key, ids)
}

#[test]
fn a_payee_tx_is_replaceable_by_anyone_after_the_grace_period_and_re_signing_never_restarts_the_clock() {
    let mut e = Env::new("relayer");
    let (key, ids) = bell(&mut e, 51);
    let id = ids[1];
    let payee = e.c.payouts.get(&id).unwrap().payee.to_string();
    assert!(sign(&mut e, &payee, id, 1).contains("E_GAS"), "a payee fee below the floor is refused");
    assert_eq!(sign(&mut e, &payee, id, MIN_PAYEE_FEE_PER_GAS), "NO PANIC");
    assert!(answer(&mut e, &key, id, true).is_some());
    assert_eq!(e.c.payouts.get(&id).unwrap().nonce, Some(0));
    // Within the grace period the payee's choice stands.
    assert!(sign(&mut e, "bell.testnet", id, 2 * GWEI).contains("E_NOT_PAYEE"));
    // The payee bumps by 1 wei just before the grace period ends: the clock does not restart.
    e.advance(1_700);
    assert_eq!(sign(&mut e, &payee, id, MIN_PAYEE_FEE_PER_GAS + 1), "NO PANIC");
    assert!(answer(&mut e, &key, id, true).is_some());
    e.advance(101);
    assert_eq!(sign(&mut e, "bell.testnet", id, 2 * GWEI), "NO PANIC", "30 min after nonce 0 was first signed anyone may replace it");
    assert!(answer(&mut e, &key, id, true).is_some());
    let st = e.c.payouts.get(&id).unwrap().signed.unwrap();
    assert!(!st.by_payee, "stored as a stranger's tx (the callback's claim is ignored)");
    assert!(st.params.nonce == 0 && st.params.max_fee_per_gas > MIN_PAYEE_FEE_PER_GAS + 1);
    assert!(st.params.max_fee_per_gas * 21_000 <= e.c.payouts.get(&id).unwrap().amount_wei / 100, "still clamped to 1%");
    // A stranger replacing a stranger still needs a strictly higher fee.
    assert!(sign(&mut e, "other.testnet", id, st.params.max_fee_per_gas - 1).contains("E_FEE_NOT_HIGHER"));
}

#[test]
fn the_payee_flag_comes_from_the_request_in_flight_not_from_a_late_callback() {
    let mut e = Env::new("relayer");
    let (key, ids) = bell(&mut e, 52);
    let id = ids[0];
    assert_eq!(sign(&mut e, "bell.testnet", id, GWEI), "NO PANIC");
    assert!(answer(&mut e, &key, id, true).is_some(), "a stale callback claiming the payee asked");
    assert!(!e.c.payouts.get(&id).unwrap().signed.unwrap().by_payee);
}

#[test]
fn small_purse_shares_fold_into_the_holder_and_the_purse_is_conserved() {
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    for _ in 0..1_000 {
        let purse = (next(1_000_000_000_000_000) + 1) as u128;
        let defenders: Vec<(AccountId, u32)> = (0..next(9)).map(|i| (acct(&format!("d{i}.testnet")), 1 + next(40) as u32)).collect();
        let plan = plan_purse(purse, &acct("vance.testnet"), &acct("holder.testnet"), &defenders, 1 + next(60) as u32);
        let folded = fold_dust(plan.clone(), MIN_PAYOUT_WEI);
        assert_eq!(folded.iter().map(|(_, a)| a).sum::<u128>(), purse);
        assert_eq!(folded[0].0, plan[0].0, "the holder stays first");
        assert!(folded[1..].iter().all(|(_, a)| *a >= MIN_PAYOUT_WEI), "no unpayable share is left");
        assert_eq!(folded.len(), 1 + plan[1..].iter().filter(|(_, a)| *a >= MIN_PAYOUT_WEI).count());
    }
}

#[test]
fn a_failed_challenge_pays_for_every_byte_it_leaves_behind() {
    let mut e = Env::new("relayer");
    e.open_season("The clerk of failures", 86_400, 0);
    e.deposit("alice.testnet", 1);
    // (The mocked blockchain resets `storage_usage` on every context switch, so the exact byte count across calls is
    // proven by the sandbox suite (t21); here: measured, non-zero, capped, and the money adds up.)
    for (n, tweak) in ["refused", "tampered", "timeout"].iter().enumerate() {
        let charged0 = e.c.stats.storage_charged;
        let before = e.bal("alice.testnet");
        let s = format!("a sentence that fails {n}");
        let id = e.challenge("alice.testnet", &s);
        let mut out: Value = near_sdk::serde_json::from_str(&e.output(&s, &raw_for(&s), true, 3)).unwrap();
        match *tweak {
            "refused" => out = json!({ "ok": false, "code": "E_NEARAI_HTTP" }),
            "tampered" => out["response"] = Value::String(out["response"].as_str().unwrap().replace("chatcmpl", "chatcmpX")),
            _ => {}
        }
        if *tweak == "timeout" {
            e.advance(601);
            e.at("carol.testnet", 0);
            assert!(e.c.expire_challenge(id));
        } else {
            e.at("relayer.testnet", 0);
            assert_ne!(e.c.submit_forge(id, out.to_string()), "Resolved");
        }
        assert_eq!(e.bal("alice.testnet"), before - FEE - e.charged(id), "{tweak}: toll - fee - storage comes back");
        assert_eq!(e.c.stats.storage_charged - charged0, e.charged(id));
        assert_eq!(e.c.get_challenge(id).unwrap()["storage_charge"], e.charged(id).to_string());
    }
}

#[test]
fn request_and_forge_mode_changes_wait_for_the_timelock_and_a_request_change_for_an_empty_forge() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the slow change", 86_400, 0);
    e.deposit("alice.testnet", 1);
    let id = e.challenge("alice.testnet", "alice forges while the owner moves");
    let model0 = e.c.model_id.clone();
    e.at("titleshot.testnet", 1);
    let (p, s) = bout_sim::rulebook::request_parts("other/model");
    e.c.set_request("other/model".into(), B64(p), B64(s), "provider_tee".into());
    e.c.set_forge_mode("outlayer".into());
    assert_eq!(e.c.model_id, model0, "nothing applies before the timelock");
    assert!(e.c.forge_mode == crate::types::ForgeMode::Relayer);
    assert_eq!(e.c.get_config()["pending_config"]["request"]["model_id"], "other/model");
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.apply_config()).contains("E_TIMELOCK"));
    e.advance(3_600);
    e.at("anyone.testnet", 0);
    assert!(msg(|| e.c.apply_config()).contains("E_PENDING_BOUTS"), "a compile is in flight");
    assert_eq!(e.deliver(id, "alice forges while the owner moves"), "Resolved", "verified against the bytes it was sent with");
    e.at("anyone.testnet", 0);
    e.c.apply_config();
    assert_eq!(e.c.model_id, "other/model");
    assert!(e.c.forge_mode == crate::types::ForgeMode::Outlayer && e.c.pending_config.is_none());
}

#[test]
fn opener_fees_count_as_money_in_so_the_solvency_view_never_frees_player_money() {
    let mut e = Env::new("outlayer");
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "Opener paid by the promoter".into(), 3600, U128(0));
    assert_eq!(e.c.stats.opener_fees, FEE);
    assert_eq!(e.c.owed(), 0, "the fee came in and went out to OutLayer: nothing is owed");
    e.deposit("bob.testnet", 1);
    assert_eq!(e.c.owed(), e.bal("bob.testnet"));
}

#[test]
fn a_vrf_proof_made_for_another_sender_is_refused() {
    let mut e = Env::new("outlayer");
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "Opener for the sender test".into(), 3600, U128(0));
    let out = e.output("Opener for the sender test", &raw_for("Opener for the sender test"), true, 8);
    e.at("titleshot.testnet", 0);
    assert_eq!(e.c.settle(1, crate::forge_out::parse_str(&out), false), "Resolved");
    use ed25519_dalek::Signer;
    for (n, who) in ["mallory.testnet", "x7"].iter().enumerate() {
        e.deposit("alice.testnet", 1);
        let s = format!("alice with a borrowed proof {n}");
        let id = e.challenge("alice.testnet", &s);
        let alpha = if n == 0 {
            format!("vrf:7:{who}:titleshot-challenge-{id}")
        } else {
            format!("vrf:{who}:titleshot.testnet:titleshot-challenge-{id}")
        };
        let sig = vrf_key().sign(alpha.as_bytes()).to_bytes();
        let mut o: Value = near_sdk::serde_json::from_str(&e.output(&s, &raw_for(&s), true, 1)).unwrap();
        o["vrf"] = json!({ "output_hex": hex::encode(sha(&sig)), "alpha": alpha, "signature_hex": hex::encode(sig) });
        e.at("titleshot.testnet", 0);
        assert_eq!(e.c.settle(id, crate::forge_out::parse_str(&o.to_string()), false), "Refunded", "{alpha}");
        assert_eq!(e.c.get_challenge(id).unwrap()["code"], "E_VRF");
    }
    let s = "alice with her own proof";
    let id = e.challenge("alice.testnet", s);
    let out = e.proved(&e.output(s, &raw_for(s), true, 1), id);
    e.at("titleshot.testnet", 0);
    assert_eq!(e.c.settle(id, crate::forge_out::parse_str(&out), false), "Resolved", "this contract's own proof");
}
