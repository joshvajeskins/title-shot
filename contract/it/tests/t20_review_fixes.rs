#![allow(unused_must_use)]
//! Test 20: fixes from the adversarial review, on the real wasm. The purse cap, the purse address that stays
//! correctable after a failed signing attempt, the deploy-gate view and the solvency view.
use anyhow::Result;
use serde_json::json;
use titleshot_it::evm::address_from_derived_key;
use titleshot_it::flows::Arena;
use titleshot_it::simx::archetype;
use titleshot_it::util::*;
use titleshot_it::world::{World, U};

const GWEI: u128 = 1_000_000_000;
const VANCE_EVM: &str = "0x000000000000000000000000000000000000a4ce";
const MAX_PURSE: u128 = 1_000_000_000_000_000_000_000_000;

#[tokio::test]
async fn a_purse_above_the_cap_is_refused_and_the_views_report_gates_and_solvency() -> Result<()> {
    let w = World::new().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 60, 10u128.pow(16)).await?;
    w.advance_secs(65).await?;
    w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    for purse in [MAX_PURSE + 1, u128::MAX] {
        let r = w.call(&w.promoter, "open_season", json!({"belt_id": arena.belt, "opener_sentence": "", "duration_sec": 3600, "purse_wei": U(purse)}), 1).await?;
        assert_code(&r, "E_AMOUNT", "purse above 1e24 wei would overflow the purse plan");
    }
    let ok = w.call(&w.promoter, "open_season", json!({"belt_id": arena.belt, "opener_sentence": "", "duration_sec": 3600, "purse_wei": U(MAX_PURSE)}), 1).await?;
    assert!(ok.is_success(), "the cap itself is accepted: {}", failure_text(&ok));
    // The deploy gates: the sandbox pins no VRF key, so the gate view must say so.
    let gates = w.view("get_deploy_gates", json!({})).await?;
    assert_eq!(gates["ok"], false);
    assert!(gates["failing"].as_array().unwrap().iter().any(|g| g["gate"] == "vrf_pubkey"), "an unpinned VRF key in outlayer mode must be reported: {gates}");
    // Solvency: a funded contract covers its players and frees the protocol share.
    let sol = w.view("get_solvency", json!({})).await?;
    assert_eq!(sol["players_covered"], true);
    assert_eq!(sol["protocol_withdrawable"], sol["protocol_balance"]);
    assert!(u(&sol["balance"]) > u(&sol["storage_cost"]) + u(&sol["owed"]), "sandbox contract has an endowment: {sol}");
    Ok(())
}

#[tokio::test]
async fn a_failed_signing_attempt_leaves_the_purse_address_correctable_and_a_real_signature_freezes_it() -> Result<()> {
    let w = World::new().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 60, 10u128.pow(16)).await?;
    let pk: String = w.sg.view("derived_public_key").args_json(json!({"path": "belt-1-s1", "predecessor": w.ts.id(), "domain_id": 0})).await?.json()?;
    let right = address_from_derived_key(&pk);
    let wrong = "0x4444444444444444444444444444444444444444";
    w.ok(&w.promoter, "set_purse_address", json!({"belt": arena.belt, "season": 1, "addr": wrong}), 1).await?;
    w.ok(&w.promoter, "set_evm_address", json!({"addr": VANCE_EVM}), 1).await?;
    w.advance_secs(65).await?;
    let ids = w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?.json::<Vec<u64>>()?;
    let id = ids[0];
    let sign = || w.call(&w.promoter, "sign_payout", json!({"payout_id": id, "max_fee_per_gas": U(2 * GWEI), "max_priority_fee_per_gas": U(GWEI / 10), "gas_limit": 60_000}), 0);
    // The purse address on record is wrong: the signature recovers elsewhere and is refused.
    sign().await?;
    let p = w.view("get_payout", json!({"payout_id": id})).await?;
    assert!(p["raw_tx"].is_null() && p["signing"] == false, "nothing stored, lock released: {p}");
    // The promoter fixes the address although a nonce was already reserved by the failed attempt.
    w.ok(&w.promoter, "set_purse_address", json!({"belt": arena.belt, "season": 1, "addr": right}), 1).await?;
    let r = sign().await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    let p = w.view("get_payout", json!({"payout_id": id})).await?;
    assert!(p["raw_tx"].is_string(), "signed after the correction: {p}");
    assert_eq!(p["nonce"], 0, "the nonce reserved by the failed attempt is reused, no gap");
    let frozen = w.call(&w.promoter, "set_purse_address", json!({"belt": arena.belt, "season": 1, "addr": wrong}), 1).await?;
    assert_code(&frozen, "E_ALREADY", "a signed payout freezes the purse address");
    Ok(())
}
