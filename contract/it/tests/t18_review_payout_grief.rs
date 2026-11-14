#![allow(unused_must_use)]
//! Adversarial review test (HIGH): `sign_payout` is callable by anyone with caller-chosen gas parameters and
//! the payee pays `gas_limit * max_fee_per_gas` out of the payout. A stranger can therefore sign someone
//! else's payout at the most expensive bounded parameters; the payee can never undo it because a re-sign is
//! only allowed with a STRICTLY HIGHER max fee (which burns even more). This test FAILS on the current
//! contract and passes once a non-payee can no longer burn more than a small share of a payout (for example:
//! only the payee may choose gas parameters, anyone else gets contract-fixed cheap defaults).
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::{json, Value};
use titleshot_it::evm::address_from_derived_key;
use titleshot_it::flows::Arena;
use titleshot_it::simx::archetype;
use titleshot_it::util::*;
use titleshot_it::world::{World, U};

const PURSE: u128 = 10_000_000_000_000_000;
const GWEI: u128 = 1_000_000_000;
const ALICE_EVM: &str = "0x00000000000000000000000000000000a11ce000";

#[tokio::test]
async fn a_stranger_cannot_burn_most_of_a_payout_through_gas_parameters_and_the_payee_can_always_choose_cheaper() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob] {
        w.deposit(a, 2 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let (y_s, y_raw) = archetype("cat who has already knocked");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 240, PURSE).await?;
    let pk: String = w.sg.view("derived_public_key").args_json(json!({"path": "belt-1-s1", "predecessor": w.ts.id(), "domain_id": 0})).await?.json()?;
    w.ok(&w.promoter, "set_purse_address", json!({"belt": arena.belt, "season": 1, "addr": address_from_derived_key(&pk)}), 1).await?;
    arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?.assert_as_asked();
    arena.fight(&w.alice, (&y_s, &y_raw), Winner::Challenger).await?.assert_as_asked();
    w.ok(&w.alice, "set_evm_address", json!({"addr": ALICE_EVM}), 1).await?;
    w.advance_secs(245).await?;
    w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    let payouts = w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?;
    let alice_id = payouts.as_array().unwrap().iter().find(|p| p["payee"] == w.alice.id().as_str()).unwrap()["id"].as_u64().unwrap();
    let amount = u(&payouts.as_array().unwrap().iter().find(|p| p["id"] == alice_id).unwrap()["amount_wei"]);

    // bob (a stranger, not the payee) signs alice's payout burning 90% of it as "gas".
    let gas_limit: u64 = 150_000;
    let max_fee = (amount * 9 / 10 / gas_limit as u128).min(50 * GWEI);
    let grief = w
        .call(&w.bob, "sign_payout", json!({"payout_id": alice_id, "max_fee_per_gas": U(max_fee), "max_priority_fee_per_gas": U(GWEI), "gas_limit": gas_limit}), 0)
        .await?;
    let p: Value = w.view("get_payout", json!({"payout_id": alice_id})).await?;
    let signed_value = if p["raw_tx"].is_null() { amount } else { u(&p["value_wei"]) };
    assert!(
        grief.is_failure() || signed_value * 2 >= amount,
        "a stranger burned {} of {} wei of alice's payout as gas (value left {}); max_fee {} wei x {} gas",
        amount - signed_value,
        amount,
        signed_value,
        max_fee,
        gas_limit
    );
    // and whatever happened, alice must still be able to get a payout that keeps most of her money
    let cheap = w
        .call(&w.alice, "sign_payout", json!({"payout_id": alice_id, "max_fee_per_gas": U(GWEI), "max_priority_fee_per_gas": U(GWEI / 10), "gas_limit": 60_000}), 0)
        .await?;
    let p: Value = w.view("get_payout", json!({"payout_id": alice_id})).await?;
    assert!(cheap.is_success() && !p["raw_tx"].is_null(), "payee could not obtain a cheap signature: {}", failure_text(&cheap));
    assert!(u(&p["value_wei"]) * 100 >= amount * 99, "payee's signed value must be within 1% of the payout, got {} of {}", u(&p["value_wei"]), amount);
    Ok(())
}
