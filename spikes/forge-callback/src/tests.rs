use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

// Recorded from a real OutLayer testnet run of the forge (tx HEmDKJCTEMV9AEqdi5SppCnNvNtBcoX4uG7f5sVtkouf).
const VRF_KEY: &str = "c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8";
const REAL_ALPHA: &str = "vrf:40461:titleshot.testnet:titleshot-challenge-7";
const REAL_OUT: &str = "2b0b299be0c9e49aa77956cb9b9e8fcdb7d9f3135bc10a5e720435dfc80638bf";
const REAL_SIG: &str = "c79fa27801355a900d12dab20f344b2ec033fe3ebd30f7a2f6277c5a1a01221b5487d4dc54f3e3d5d7e12bff265e3051a14891ffb08fa75bae34185e23440809";
const DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
const FEE: u128 = 10_000_000_000_000_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn contract(key: &str) -> ForgeCallback {
    testing_env!(VMContextBuilder::new().current_account_id(acct("fc.testnet")).build());
    ForgeCallback::new(acct("outlayer.testnet"), "o.testnet/forge".into(), "m/x".into(), key.into(), U128(FEE), "default".into(), acct("o.testnet"))
}

fn real_vrf() -> Value {
    json!({"alpha": REAL_ALPHA, "output_hex": REAL_OUT, "signature_hex": REAL_SIG})
}

fn resume(c: &mut ForgeCallback, id: u64, result: Result<Option<Value>, PromiseError>) -> Last {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acct("fc.testnet"))
            .predecessor_account_id(acct("fc.testnet"))
            .block_height(123)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    c.on_forged(id, acct("player.testnet"), U128(DEPOSIT), result)
}

fn refunds(expected: bool) {
    let n = get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == "player.testnet" && r.actions.iter().any(|a| format!("{a:?}").contains("Transfer")))
        .count();
    assert_eq!(n, expected as usize);
}

#[test]
fn real_vrf_proof_is_accepted_and_logged() {
    let mut c = contract(VRF_KEY);
    let out = json!({"ok": true, "vrf": real_vrf()});
    let l = resume(&mut c, 7, Ok(Some(out)));
    assert!(l.accepted && l.vrf_ok && !l.has_ai, "{}", l.reason);
    assert_eq!(l.vrf_output, REAL_OUT);
    assert!(l.result_bytes > 100 && c.last().unwrap().accepted);
    let logs = get_logs().join("\n");
    assert!(logs.contains("forge result:") && logs.contains("\"event\":\"forged\""), "{logs}");
    refunds(true);
}

#[test]
fn ai_fields_are_noticed() {
    let mut c = contract(VRF_KEY);
    let out = json!({"ok": true, "response": "{}", "signature": "0x00", "vrf": real_vrf()});
    assert!(resume(&mut c, 7, Ok(Some(out))).has_ai);
}

#[test]
fn null_result_is_a_refusal_not_a_panic_and_refunds() {
    let mut c = contract(VRF_KEY);
    let l = resume(&mut c, 7, Ok(None));
    assert!(!l.accepted && l.reason.contains("null result"));
    assert!(get_logs().join("\n").contains("forge_refused"));
    refunds(true);
    let l = resume(&mut c, 7, Err(PromiseError::Failed));
    assert!(!l.accepted && l.reason.contains("promise failed"));
    refunds(true);
}

#[test]
fn forge_error_is_reported_with_code() {
    let mut c = contract(VRF_KEY);
    let l = resume(&mut c, 7, Ok(Some(json!({"ok": false, "code": "E_AI_STATUS", "detail": "429 slow down"}))));
    assert!(!l.accepted && l.reason.contains("E_AI_STATUS") && l.reason.contains("429"));
}

#[test]
fn vrf_for_another_challenge_is_refused() {
    let mut c = contract(VRF_KEY);
    let l = resume(&mut c, 8, Ok(Some(json!({"ok": true, "vrf": real_vrf()}))));
    assert!(!l.accepted && l.reason.contains("not for this challenge"));
}

#[test]
fn forged_vrf_from_another_key_is_refused() {
    let mut c = contract(VRF_KEY);
    let sk = SigningKey::from_bytes(&[9u8; 32]);
    let sig = sk.sign(REAL_ALPHA.as_bytes()).to_bytes();
    let vrf = json!({"alpha": REAL_ALPHA, "signature_hex": hex::encode(sig), "output_hex": hex::encode(env::sha256(&sig))});
    let l = resume(&mut c, 7, Ok(Some(json!({"ok": true, "vrf": vrf}))));
    assert!(!l.accepted && l.reason.contains("does not verify"));
}

#[test]
fn output_not_derived_from_signature_is_refused() {
    let mut c = contract(VRF_KEY);
    let vrf = json!({"alpha": REAL_ALPHA, "signature_hex": REAL_SIG, "output_hex": "00".repeat(32)});
    let l = resume(&mut c, 7, Ok(Some(json!({"ok": true, "vrf": vrf}))));
    assert!(!l.accepted && l.reason.contains("sha256"));
}

#[test]
fn malformed_results_never_panic() {
    let mut c = contract(VRF_KEY);
    for v in [json!(null), json!([]), json!({"ok": true}), json!({"ok": true, "vrf": {"alpha": 1}}),
              json!({"ok": true, "vrf": {"alpha": REAL_ALPHA, "signature_hex": "zz", "output_hex": "x"}})] {
        assert!(!resume(&mut c, 7, Ok(Some(v))).accepted);
    }
}

#[test]
#[should_panic(expected = "attach more than the forge fee")]
fn request_requires_more_than_the_fee() {
    let mut c = contract(VRF_KEY);
    testing_env!(VMContextBuilder::new().current_account_id(acct("fc.testnet")).attached_deposit(NearToken::from_yoctonear(FEE)).build());
    c.forge_vrf_only(1);
}

#[test]
#[should_panic(expected = "sentence must be 3-120 chars")]
fn forge_rejects_short_sentence() {
    let mut c = contract(VRF_KEY);
    testing_env!(VMContextBuilder::new().current_account_id(acct("fc.testnet")).attached_deposit(NearToken::from_yoctonear(DEPOSIT)).build());
    c.forge("ab".into(), 1);
}

#[test]
fn forge_schedules_request_then_callback() {
    let mut c = contract(VRF_KEY);
    testing_env!(VMContextBuilder::new().current_account_id(acct("fc.testnet")).predecessor_account_id(acct("player.testnet")).attached_deposit(NearToken::from_yoctonear(DEPOSIT)).build());
    let _ = c.forge("A baker who fights with rolling pins".into(), 5);
    let r = get_created_receipts();
    let calls = |to: &str, name: &str| {
        r.iter().any(|x| {
            x.receiver_id.as_str() == to
                && x.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == name.as_bytes()))
        })
    };
    assert!(calls("outlayer.testnet", "request_execution"));
    assert!(calls("fc.testnet", "on_forged"));
}

#[test]
fn request_carries_secrets_ref_and_json_format() {
    let mut c = contract(VRF_KEY);
    testing_env!(VMContextBuilder::new().current_account_id(acct("fc.testnet")).predecessor_account_id(acct("player.testnet")).attached_deposit(NearToken::from_yoctonear(DEPOSIT)).build());
    let _ = c.forge("A baker who fights with rolling pins".into(), 5);
    let receipts = get_created_receipts();
    let args = receipts
        .iter()
        .filter(|r| r.receiver_id.as_str() == "outlayer.testnet")
        .flat_map(|r| r.actions.iter())
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { args, .. } => Some(args.clone()),
            _ => None,
        })
        .unwrap();
    let v: Value = near_sdk::serde_json::from_slice(&args).unwrap();
    assert_eq!(v["secrets_ref"], json!({"profile": "default", "account_id": "o.testnet"}));
    assert_eq!(v["response_format"], "Json");
    assert_eq!(v["source"]["Project"]["project_id"], "o.testnet/forge");
    let input: Value = near_sdk::serde_json::from_str(v["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["need_compile"], true);
    assert_eq!(input["challenge_id"], 5);
}
