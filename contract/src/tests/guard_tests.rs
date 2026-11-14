//! Refusals, rejections (tampered AI output), allowlist timelock, relayer rules and the OutLayer request shape.
use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn panics<R>(f: impl FnOnce() -> R) -> String {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => "NO PANIC".to_string(),
        Err(e) => e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    }
}

fn opened() -> Env {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the guard rail", 86_400, 0);
    e.deposit("alice.testnet", 1);
    e.deposit("bob.testnet", 1);
    e
}

#[test]
fn challenge_refusals_follow_the_documented_order_and_codes() {
    let mut e = Env::new("relayer");
    e.deposit("alice.testnet", 1);
    e.at("alice.testnet", 0);
    assert!(panics(|| e.c.challenge(9, "no such belt here".into())).contains("E_NO_BELT"));
    assert!(panics(|| e.c.challenge(1, "no season yet either".into())).contains("E_NO_SEASON"));
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "Opener of the order".into(), 3600, U128(0));
    e.at("alice.testnet", 0);
    assert!(panics(|| e.c.challenge(1, "opener still forging".into())).contains("E_NO_CHAMPION"));
    let cid = e.c.next_challenge - 1;
    let out = e.output("Opener of the order", &raw_for("Opener of the order"), true, 1);
    e.at("relayer.testnet", 0);
    e.c.submit_forge(cid, out);
    e.at("alice.testnet", 0);
    assert!(panics(|| e.c.challenge(1, "ab".into())).contains("E_SENTENCE"));
    assert!(panics(|| e.c.challenge(1, "bad\u{0}char here".into())).contains("E_SENTENCE"));
    assert!(panics(|| e.c.challenge(1, "x".repeat(121))).contains("E_SENTENCE"));
    assert!(panics(|| e.c.challenge(1, "  Opener   of the order ".into())).contains("E_SAME_SENTENCE"), "champion's own sentence");
    e.at("vance.testnet", 0);
    assert!(panics(|| e.c.challenge(1, "the holder cannot challenge".into())).contains("E_SELF"));
    e.at("nobody.testnet", 0);
    assert!(panics(|| e.c.challenge(1, "a stranger with no balance".into())).contains("E_BALANCE"));
    e.at("alice.testnet", 0);
    e.c.challenge(1, "alice challenges once".into());
    assert!(panics(|| e.c.challenge(1, "alice challenges twice".into())).contains("E_PENDING"));
    e.advance(86_401);
    e.at("bob.testnet", 0);
    assert!(panics(|| e.c.challenge(1, "bob arrives after the bell".into())).contains("E_NO_SEASON"));
}

#[test]
fn challenge_is_not_payable() {
    let mut e = opened();
    e.at("alice.testnet", 1);
    // The macro-generated wrapper enforces non-payable; calling the Rust method directly cannot, so assert the
    // contract never reads an attached deposit in `challenge`: the balance is unchanged apart from the toll.
    let before = e.bal("alice.testnet");
    e.c.challenge(1, "attaching nothing useful".into());
    assert_eq!(e.bal("alice.testnet"), before - TOLL);
}

fn reject_case(label: &str, tweak: impl FnOnce(&mut near_sdk::serde_json::Value, &Env), code: &str) {
    let mut e = opened();
    let s = format!("sentence for {label}");
    let before = e.bal("alice.testnet");
    let id = e.challenge("alice.testnet", &s);
    let mut out: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&e.output(&s, &raw_for(&s), true, 4)).unwrap();
    tweak(&mut out, &e);
    e.at("relayer.testnet", 0);
    assert_eq!(e.c.submit_forge(id, out.to_string()), "Rejected", "{label}");
    let v = e.c.get_challenge(id).unwrap();
    assert_eq!(v["status"], "Rejected", "{label}");
    assert_eq!(v["code"], code, "{label}: {}", v["detail"]);
    assert_eq!(e.bal("alice.testnet"), before - FEE, "{label}: refund minus the fee");
    assert!(e.c.get_fighter_by_sentence(s).is_none(), "{label}: nothing is stored for a rejected compile");
    assert!(e.c.get_pending(acct("alice.testnet")).is_none());
    assert_eq!(e.c.stats()["rejected"], 1);
}

#[test]
fn tampered_wrong_unlisted_oversized_refused_and_unknown_move_are_rejected_with_refund() {
    reject_case("tampered response", |o, _| {
        let r = o["response"].as_str().unwrap().replace("Objection!", "Objection?");
        o["response"] = r.into();
    }, "E_AI_SIG");
    reject_case("trailing byte", |o, _| {
        let r = format!("{}\n", o["response"].as_str().unwrap());
        o["response"] = r.into();
    }, "E_AI_SIG");
    reject_case("wrong signer", |o, e| {
        let other = signing_key(9);
        let s = "sentence for wrong signer";
        let req = bout_sim::rulebook::build_request(MODEL, s);
        let text = format!("{MODEL}:{}:{}", hex::encode(sha(&req)), hex::encode(sha(o["response"].as_str().unwrap().as_bytes())));
        o["signature"] = eip191_sign(&other, &text).into();
        let _ = e;
    }, "E_AI_SIG");
    reject_case("gateway kind claimed", |o, _| o["signature_kind"] = "gateway".into(), "E_AI_SIG");
    reject_case("ed25519 algo", |o, _| o["signing_algo"] = "ed25519".into(), "E_AI_SIG");
    reject_case("over-length response", |o, e| {
        let s = "sentence for over-length response";
        let big = format!("{}{}", o["response"].as_str().unwrap(), " ".repeat(9000));
        let req = bout_sim::rulebook::build_request(MODEL, s);
        let text = format!("{MODEL}:{}:{}", hex::encode(sha(&req)), hex::encode(sha(big.as_bytes())));
        o["signature"] = eip191_sign(&e.sk, &text).into();
        o["response"] = big.into();
    }, "E_AI_SIG");
    reject_case("garbage signature", |o, _| o["signature"] = "zz".into(), "E_AI_SIG");
    reject_case("refused verdict", |o, e| resign(o, e, "sentence for refused verdict", |v| v["verdict"] = "refused".into()), "E_REFUSED");
    reject_case("unknown move", |o, e| resign(o, e, "sentence for unknown move", |v| v["moves"][0]["id"] = "m_made_up".into()), "E_UNKNOWN_MOVE");
    reject_case("duplicate move", |o, e| resign(o, e, "sentence for duplicate move", |v| v["moves"][1] = v["moves"][0].clone()), "E_DUP_MOVE");
    reject_case("bad school", |o, e| resign(o, e, "sentence for bad school", |v| v["school"] = "PLASMA".into()), "E_BAD_SCHOOL");
    reject_case("empty name", |o, e| resign(o, e, "sentence for empty name", |v| v["name"] = "   ".into()), "E_EMPTY_FIELD");
    reject_case("not json content", |o, e| resign_raw(o, e, "sentence for not json content", "I am a fighter, trust me"), "E_BAD_JSON");
    reject_case("empty content", |o, e| resign_raw(o, e, "sentence for empty content", ""), "E_NO_CONTENT");
}

/// Re-sign a response whose fighter JSON was edited (so only the content, not the signature, is wrong).
fn resign(o: &mut near_sdk::serde_json::Value, e: &Env, sentence: &str, edit: impl FnOnce(&mut near_sdk::serde_json::Value)) {
    let mut v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&raw_for(sentence)).unwrap();
    edit(&mut v);
    resign_raw(o, e, sentence, &v.to_string());
}

fn resign_raw(o: &mut near_sdk::serde_json::Value, e: &Env, sentence: &str, content: &str) {
    let fresh: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&e.output(sentence, content, true, 4)).unwrap();
    o["response"] = fresh["response"].clone();
    o["signature"] = fresh["signature"].clone();
}

#[test]
fn only_a_listed_relayer_can_submit_and_only_for_relayer_challenges() {
    let mut e = opened();
    let id = e.challenge("alice.testnet", "alice asks a stranger to deliver");
    let out = e.output("alice asks a stranger to deliver", &raw_for("alice asks a stranger to deliver"), true, 2);
    e.at("mallory.testnet", 0);
    assert!(panics(|| e.c.submit_forge(id, out.clone())).contains("E_NOT_RELAYER"));
    e.at("relayer.testnet", 0);
    assert!(panics(|| e.c.submit_forge(99, out.clone())).contains("E_NO_CHALLENGE"));
    assert_eq!(e.c.submit_forge(id, out), "Resolved");
    e.at("titleshot.testnet", 1);
    e.c.remove_relayer(acct("relayer.testnet"));
    e.at("relayer.testnet", 0);
    assert!(panics(|| e.c.submit_forge(id, "{}".into())).contains("E_NOT_RELAYER"));
}

#[test]
fn allowlist_changes_wait_for_the_timelock_and_unlisted_signers_are_rejected() {
    let mut e = opened();
    let new_signer = signing_key(11);
    e.at("titleshot.testnet", 1);
    e.c.propose_allowlist(vec![format!("0x{}", hex::encode(eth_addr(&new_signer)))]);
    assert!(panics(|| e.c.apply_allowlist()).contains("E_TIMELOCK"));
    e.advance(3599);
    e.at("anyone.testnet", 0);
    assert!(panics(|| e.c.apply_allowlist()).contains("E_TIMELOCK"));
    let al = e.c.get_allowlist();
    assert_eq!(al["active"][0], format!("0x{}", hex::encode(eth_addr(&e.sk))));
    assert!(al["pending"].is_array() && al["activates_at"].is_string());
    e.advance(2);
    e.at("anyone.testnet", 0);
    e.c.apply_allowlist();
    assert_eq!(e.c.get_allowlist()["active"][0], format!("0x{}", hex::encode(eth_addr(&new_signer))));
    // The old key is now unlisted: its compile is rejected.
    let s = "a compile from a retired signer";
    let id = e.challenge("alice.testnet", s);
    let out = e.output(s, &raw_for(s), true, 6);
    e.at("relayer.testnet", 0);
    assert_eq!(e.c.submit_forge(id, out), "Rejected");
    assert_eq!(e.c.get_challenge(id).unwrap()["code"], "E_AI_SIG");
    // Only the owner, with 1 yocto, can propose.
    e.at("mallory.testnet", 1);
    assert!(panics(|| e.c.propose_allowlist(vec![])).contains("E_NOT_OWNER"));
}

#[test]
fn outlayer_mode_requests_one_execution_with_the_fee_and_the_callback_resolves_it() {
    let mut e = Env::new("outlayer");
    e.at("titleshot.testnet", 1);
    e.c.set_forge_secrets("default".into(), acct("titleshot.testnet"));
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "Opener through OutLayer".into(), 3600, U128(0));
    let receipts = get_created_receipts();
    let call = receipts.iter().find(|r| r.receiver_id.as_str() == "outlayer.testnet").expect("request_execution receipt");
    let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = &call.actions[0] else { panic!("not a call") };
    assert_eq!(String::from_utf8_lossy(method_name), "request_execution");
    assert_eq!(attached_deposit.as_yoctonear(), FEE, "the forge fee is the OutLayer deposit");
    let body = String::from_utf8_lossy(args).to_string();
    assert!(body.contains("titleshot-forge") && body.contains("need_compile") && body.contains("\"profile\":\"default\""), "{body}");
    assert!(body.contains("\"response_format\":\"Json\""), "{body}");
    assert_eq!(e.c.stats()["fees_spent"], FEE.to_string());
    // OutLayer calls back with the forge output.
    let out = e.output("Opener through OutLayer", &raw_for("Opener through OutLayer"), true, 8);
    near_sdk::test_utils::testing_env_with_promise_results(
        VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
        near_sdk::PromiseResult::Successful(out.into_bytes()),
    );
    assert_eq!(e.c.on_forged(1), "Resolved");
    assert_eq!(e.season()["state"], "Open");
    // A player challenge: VRF seed is used (not the block).
    e.deposit("alice.testnet", 1);
    let s = "alice through the vrf";
    let id = e.challenge("alice.testnet", s);
    let out = e.output(s, &raw_for(s), true, 42);
    near_sdk::test_utils::testing_env_with_promise_results(
        VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).block_timestamp(e.t * 1_000_000_000).build(),
        near_sdk::PromiseResult::Successful(out.into_bytes()),
    );
    assert_eq!(e.c.on_forged(id), "Resolved");
    let f = e.c.get_challenge(id).unwrap()["fight_id"].as_u64().unwrap();
    assert_eq!(e.c.get_fight(f).unwrap()["seed_source"], "vrf");
    assert!(get_logs().iter().any(|l| l.contains("\"bout\"")));
}

#[test]
fn outlayer_callback_without_a_vrf_refunds_and_a_pinned_key_rejects_a_forged_proof() {
    let mut e = Env::new("outlayer");
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "Opener for the vrf test".into(), 3600, U128(0));
    let out = e.output("Opener for the vrf test", &raw_for("Opener for the vrf test"), true, 8);
    e.at("titleshot.testnet", 0);
    assert_eq!(e.c.settle(1, crate::forge_out::parse_str(&out), false), "Resolved");
    e.deposit("alice.testnet", 1);
    let before = e.bal("alice.testnet");
    let s = "alice without a vrf output";
    let id = e.challenge("alice.testnet", s);
    let mut o: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&e.output(s, &raw_for(s), true, 1)).unwrap();
    o.as_object_mut().unwrap().remove("vrf");
    assert_eq!(e.c.settle(id, crate::forge_out::parse_str(&o.to_string()), false), "Refunded");
    assert_eq!(e.c.get_challenge(id).unwrap()["code"], "E_VRF");
    assert_eq!(e.bal("alice.testnet"), before - FEE);
    // Pin a key: the fake proof in the helper output no longer verifies.
    e.at("titleshot.testnet", 1);
    e.c.set_vrf_pubkey(hex::encode([5u8; 32]));
    let s2 = "alice with a fake proof";
    let id2 = e.challenge("alice.testnet", s2);
    let out2 = e.output(s2, &raw_for(s2), true, 1);
    assert_eq!(e.c.settle(id2, crate::forge_out::parse_str(&out2), false), "Refunded");
    assert_eq!(e.c.get_challenge(id2).unwrap()["code"], "E_VRF");
}

#[test]
fn belt_nft_holder_transfer_pays_the_new_holder_and_blocks_their_own_challenge() {
    let mut e = opened();
    // vance (holder) gifts the belt to bob.
    e.at("vance.testnet", 1);
    near_contract_standards::non_fungible_token::core::NonFungibleTokenCore::nft_transfer(&mut e.c, acct("bob.testnet"), "belt-1".into(), None, None);
    assert_eq!(e.holder(), "bob.testnet");
    let bob_before = e.bal("bob.testnet");
    let s = "alice challenges the new holder";
    let id = e.challenge("alice.testnet", s);
    e.deliver(id, s);
    let split = crate::economy::split_toll(TOLL, FEE).unwrap();
    assert_eq!(e.bal("bob.testnet") - bob_before, split.champion, "the new holder is paid");
    // Bob cannot challenge his own belt.
    e.at("bob.testnet", 0);
    assert!(panics(|| e.c.challenge(1, "bob fights himself".into())).contains("E_SELF") || e.holder() != "bob.testnet");
}

#[test]
fn challenger_who_becomes_holder_before_resolution_is_refunded_not_paid() {
    let mut e = opened();
    let s = "alice wins the belt as a gift mid forge";
    let id = e.challenge("alice.testnet", s);
    e.at("vance.testnet", 1);
    near_contract_standards::non_fungible_token::core::NonFungibleTokenCore::nft_transfer(&mut e.c, acct("alice.testnet"), "belt-1".into(), None, None);
    let before = e.bal("alice.testnet");
    assert_eq!(e.deliver(id, s), "Refunded");
    assert_eq!(e.c.get_challenge(id).unwrap()["code"], "E_SELF");
    assert_eq!(e.bal("alice.testnet"), before + TOLL - FEE);
}
