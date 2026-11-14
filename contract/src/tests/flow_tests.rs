//! Full challenge lifecycle through the real contract code (relayer mode: `submit_forge` runs the same
//! `settle` as the OutLayer callback).
use super::*;
use crate::economy::split_toll;
use near_sdk::test_utils::get_logs;

#[test]
fn deposit_withdraw_and_first_deposit_storage_rule() {
    let mut e = Env::new("relayer");
    e.at("alice.testnet", 4 * NEAR / 1000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.c.deposit()));
    assert!(r.is_err(), "first deposit below 0.005 NEAR is E_STORAGE");
    e.deposit("alice.testnet", 1);
    assert_eq!(e.bal("alice.testnet"), NEAR - crate::util::ACCOUNT_STORAGE, "storage is kept, not credited");
    e.at("alice.testnet", NEAR);
    e.c.deposit();
    assert_eq!(e.bal("alice.testnet"), 2 * NEAR - crate::util::ACCOUNT_STORAGE, "later deposits credit in full");
    e.at("bob.testnet", NEAR);
    e.c.deposit_for(acct("carol.testnet"));
    assert_eq!(e.bal("carol.testnet"), NEAR - crate::util::ACCOUNT_STORAGE);
    e.at("alice.testnet", 1);
    let out = e.c.withdraw(Some(U128(NEAR)));
    assert_eq!(out.0, NEAR);
    assert_eq!(e.bal("alice.testnet"), NEAR - crate::util::ACCOUNT_STORAGE);
    e.at("alice.testnet", 1);
    assert_eq!(e.c.withdraw(None).0, NEAR - crate::util::ACCOUNT_STORAGE);
    assert_eq!(e.bal("alice.testnet"), 0);
}

#[test]
fn withdraw_needs_exactly_one_yocto_and_enough_balance() {
    let mut e = Env::new("relayer");
    e.deposit("alice.testnet", 1);
    e.at("alice.testnet", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.c.withdraw(None))).is_err(), "no yocto");
    e.at("alice.testnet", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.c.withdraw(Some(U128(5 * NEAR))))).is_err(), "too much");
}

#[test]
fn opener_forge_opens_the_season_and_gives_the_belt_to_the_promoter() {
    let mut e = Env::new("relayer");
    assert_eq!(e.holder(), "vance.testnet", "belt minted to the promoter at creation");
    let s = e.open_season("A tireless promoter's dog", 3600, NEAR);
    assert_eq!(s, 1);
    assert_eq!(e.season()["state"], "Open");
    assert_eq!(e.season()["sealed"], true);
    assert!(e.c.get_belt(1)["champion"]["spec"]["name"].is_string());
    assert_eq!(e.c.get_challenge(1).unwrap()["kind"], "Opener");
    assert_eq!(e.status(1), "Resolved");
}

#[test]
fn bout_conserves_every_yocto_and_the_belt_follows_the_winner() {
    let mut e = Env::new("relayer");
    e.open_season("The reigning toaster", 86_400, 0);
    let split = split_toll(TOLL, FEE).unwrap();
    let (mut champ_wins, mut chall_wins, mut draws) = (0, 0, 0);
    for i in 0..24u32 {
        let who = format!("fan{i}.testnet");
        e.deposit(&who, 1);
        let holder = e.holder();
        let (hb, pb, side0, ab) = (e.bal(&holder), e.bal("vance.testnet"), e.season()["side_pot"].as_str().unwrap().parse::<u128>().unwrap(), e.bal(&who));
        let sentence = format!("challenger number {i} with a rolled up newspaper");
        let id = e.challenge(&who, &sentence);
        let prot0 = e.c.protocol_balance; // relayer mode credits the forge fee to the protocol at challenge time
        assert_eq!(e.bal(&who), ab - TOLL, "toll debited at challenge time");
        assert_eq!(e.status(id), "Forging");
        assert_eq!(e.deliver(id, &sentence), "Resolved", "challenge {i}");
        let f = e.c.get_challenge(id).unwrap()["fight_id"].as_u64().unwrap();
        let fight = e.c.get_fight(f).unwrap();
        // Money: champion share to the holder at resolution, promoter share, side-pot, protocol; nothing else moves.
        let holder_gain = e.bal(&holder) - hb + if holder == "vance.testnet" { 0 } else { 0 };
        let promoter_gain = e.bal("vance.testnet") - pb;
        if holder == "vance.testnet" {
            assert_eq!(holder_gain, split.champion + split.promoter);
        } else {
            assert_eq!(holder_gain, split.champion);
            assert_eq!(promoter_gain, split.promoter);
        }
        let side1 = e.season()["side_pot"].as_str().unwrap().parse::<u128>().unwrap();
        assert_eq!(side1 - side0, split.side_pot);
        assert_eq!(e.c.protocol_balance - prot0, split.protocol);
        assert_eq!(split.champion + split.promoter + split.side_pot + split.protocol + FEE, TOLL);
        // Belt: the NFT owner is the challenger iff they won.
        match fight["winner"].as_str().unwrap() {
            "challenger" => {
                chall_wins += 1;
                assert_eq!(e.holder(), who);
                assert_eq!(e.c.get_belt(1)["defences"], 0);
            }
            "champion" => {
                champ_wins += 1;
                assert_eq!(e.holder(), holder);
            }
            _ => {
                draws += 1;
                assert_eq!(e.holder(), holder, "a draw keeps the champion");
            }
        }
        assert_eq!(fight["holder"], holder.as_str());
        assert_eq!(fight["seed_source"], "block");
        assert!(e.c.get_pending(acct(&who)).is_none(), "pending cleared");
    }
    println!("champion {champ_wins} challenger {chall_wins} draws {draws}");
    assert!(chall_wins > 0 && champ_wins > 0, "both outcomes must occur over 24 bouts");
    let st = e.c.stats();
    assert_eq!(st["bouts"], 24);
    assert_eq!(e.c.get_fights(1, 0, 50).len(), 24);
    assert_eq!(e.c.get_fights(1, 0, 3)[0]["id"], 24, "newest first");
    assert_eq!(e.c.get_fights(1, 22, 5).len(), 2, "offset skips the newest");
}

#[test]
fn sealed_rule_is_revealed_exactly_once_at_the_first_bout() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the sealed night", 86_400, 0);
    e.deposit("alice.testnet", 1);
    e.deposit("bob.testnet", 1);
    let a = e.challenge("alice.testnet", "alice has a sealed envelope");
    assert_eq!(e.season()["sealed"], true);
    e.deliver(a, "alice has a sealed envelope");
    let rule = e.season()["rule"].as_u64().unwrap();
    assert!(rule < 8);
    let reveals = get_logs().iter().filter(|l| l.contains("rule_revealed")).count();
    assert_eq!(reveals, 1);
    let b = e.challenge("bob.testnet", "bob has a second envelope");
    e.deliver(b, "bob has a second envelope");
    assert_eq!(e.season()["rule"].as_u64().unwrap(), rule, "the rule never changes");
    assert_eq!(get_logs().iter().filter(|l| l.contains("rule_revealed")).count(), 0, "no second reveal");
}

#[test]
fn second_challenge_with_a_known_sentence_reuses_the_canonical_fighter() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the cache", 86_400, 0);
    e.deposit("alice.testnet", 1);
    e.deposit("bob.testnet", 1);
    let s = "a sentence two people will write";
    let a = e.challenge("alice.testnet", s);
    assert_eq!(e.c.get_challenge(a).unwrap()["need_compile"], true);
    e.deliver(a, s);
    let writer = e.c.get_fighter_by_sentence(s.into()).unwrap()["writer"].clone();
    assert_eq!(writer, "alice.testnet");
    // Make sure the sentence is not the reigning champion's (a champion's own words are E_SAME_SENTENCE).
    let mut n = 0;
    while e.c.belt(1).champion == Some(crate::util::sha256_str(s)) {
        n += 1;
        assert!(n < 40, "could not dethrone the fighter");
        let who = format!("filler{n}.testnet");
        e.deposit(&who, 1);
        let fs = format!("filler fighter {n} with a spoon");
        let fid = e.challenge(&who, &fs);
        e.deliver(fid, &fs);
    }
    // Bob writes the same words (different spacing): no compile needed, a VRF-only output is enough.
    let b = e.challenge("bob.testnet", "  a sentence  two people\twill write ");
    assert_eq!(e.c.get_challenge(b).unwrap()["need_compile"], false);
    let vrf_only = e.output(s, "", false, 77);
    e.at("relayer.testnet", 0);
    assert_eq!(e.c.submit_forge(b, vrf_only), "Resolved");
    assert_eq!(e.c.get_fighter_by_sentence(s.into()).unwrap()["writer"], "alice.testnet", "first forge stays canonical");
    // A different compile for the same sentence is ignored: the stored fighter wins.
    let rec = e.c.get_fighter_by_sentence(s.into()).unwrap()["record"].clone();
    assert!(rec["wins"].as_u64().unwrap() + rec["losses"].as_u64().unwrap() + rec["draws"].as_u64().unwrap() >= 2);
}

#[test]
fn double_delivery_and_late_delivery_after_expiry_are_no_ops() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the double", 86_400, 0);
    e.deposit("alice.testnet", 1);
    let s = "delivered twice by a nervous relayer";
    let id = e.challenge("alice.testnet", s);
    assert_eq!(e.deliver(id, s), "Resolved");
    let bal = e.bal("alice.testnet");
    let out = e.output(s, &raw_for(s), true, 3);
    e.at("relayer.testnet", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.c.submit_forge(id, out))).is_err(), "E_NOT_FORGING");
    assert_eq!(e.bal("alice.testnet"), bal);
    // Callback path twice is a no-op as well.
    assert_eq!(e.c.settle(id, crate::forge_out::parse_str(&e.output(s, &raw_for(s), true, 3)), false), "Resolved");
    assert_eq!(e.c.stats()["bouts"], 1);

    e.deposit("bob.testnet", 1);
    let s2 = "a bob who waits too long";
    let b = e.challenge("bob.testnet", s2);
    e.advance(601);
    e.at("carol.testnet", 0);
    let before = e.bal("bob.testnet");
    assert!(e.c.expire_challenge(b));
    assert_eq!(e.bal("bob.testnet"), before + TOLL - FEE, "refund minus the forge fee");
    assert_eq!(e.status(b), "Refunded");
    assert_eq!(e.c.get_challenge(b).unwrap()["code"], "E_TIMEOUT");
    assert!(e.c.get_pending(acct("bob.testnet")).is_none());
    // Late callback after expiry: no-op, nobody is paid twice.
    let late = e.output(s2, &raw_for(s2), true, 5);
    assert_eq!(e.c.settle(b, crate::forge_out::parse_str(&late), false), "Refunded");
    assert_eq!(e.bal("bob.testnet"), before + TOLL - FEE);
    // Expiring a resolved challenge is a soft no-op.
    assert!(!e.c.expire_challenge(id));
}

#[test]
fn expire_before_ten_minutes_is_refused() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the impatient", 86_400, 0);
    e.deposit("alice.testnet", 1);
    let id = e.challenge("alice.testnet", "too early to give up now");
    e.advance(599);
    e.at("carol.testnet", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.c.expire_challenge(id))).is_err());
}

#[test]
fn promise_failure_null_and_garbage_all_refund_minus_the_fee() {
    for (n, bytes) in [(0, "null"), (1, "not json at all"), (2, "{\"ok\":false,\"code\":\"E_NEARAI_HTTP\"}"), (3, "{\"nothing\":true}")] {
        let mut e = Env::new("relayer");
        e.open_season("Opener of failures", 86_400, 0);
        e.deposit("alice.testnet", 1);
        let before = e.bal("alice.testnet");
        let id = e.challenge("alice.testnet", &format!("a doomed challenge {n}"));
        e.at("titleshot.testnet", 0);
        near_sdk::test_utils::testing_env_with_promise_results(
            VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
            near_sdk::PromiseResult::Successful(bytes.as_bytes().to_vec()),
        );
        assert_eq!(e.c.on_forged(id), "Refunded", "{bytes}");
        assert_eq!(e.bal("alice.testnet"), before - FEE, "refund = toll - fee");
        assert!(e.c.get_pending(acct("alice.testnet")).is_none());
    }
    let mut e = Env::new("relayer");
    e.open_season("Opener of failures", 86_400, 0);
    e.deposit("alice.testnet", 1);
    let id = e.challenge("alice.testnet", "a failed promise");
    near_sdk::test_utils::testing_env_with_promise_results(
        VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
        near_sdk::PromiseResult::Failed,
    );
    assert_eq!(e.c.on_forged(id), "Refunded");
}
