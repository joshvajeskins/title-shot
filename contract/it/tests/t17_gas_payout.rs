#![allow(unused_must_use)]
//! Gas report for the bell: worst-case `close_season` (5 bouts, 3 payees, a title change, side-pot) and
//! `sign_payout` (signer call + callback with ecrecover of the MPC signature). Writes gas-report-bell.json.
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
async fn close_season_and_sign_payout_gas_stay_inside_the_budget() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol] {
        w.deposit(a, 2 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let f: Vec<(String, Value)> = ["raccoon running a casino", "cat who has already knocked", "mime trapped", "disco ball", "dragon who only collects socks"]
        .iter()
        .map(|n| archetype(n))
        .collect();
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 900, PURSE).await?;
    let pk: String = w.sg.view("derived_public_key").args_json(json!({"path": "belt-1-s1", "predecessor": w.ts.id(), "domain_id": 0})).await?.json()?;
    w.ok(&w.promoter, "set_purse_address", json!({"belt": arena.belt, "season": 1, "addr": address_from_derived_key(&pk)}), 1).await?;
    let plan = [(&w.bob, Winner::Champion), (&w.carol, Winner::Champion), (&w.alice, Winner::Challenger), (&w.bob, Winner::Champion), (&w.carol, Winner::Challenger)];
    for (i, (who, want)) in plan.into_iter().enumerate() {
        arena.fight(who, (&f[i].0, &f[i].1), want).await?.assert_as_asked();
    }
    w.ok(&w.alice, "set_evm_address", json!({"addr": ALICE_EVM}), 1).await?;
    w.advance_secs(900).await?;
    let close = w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    let close_total = tgas(close.total_gas_burnt);
    println!("GAS close_season (5 bouts, 3 payees): {close_total:.1} Tgas");
    let payouts = w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?;
    let alice_id = payouts.as_array().unwrap().iter().find(|p| p["payee"] == w.alice.id().as_str()).unwrap()["id"].as_u64().unwrap();
    let sign = w.ok(&w.alice, "sign_payout", json!({"payout_id": alice_id, "max_fee_per_gas": U(2 * GWEI), "max_priority_fee_per_gas": U(GWEI / 10), "gas_limit": 60_000u64}), 0).await?;
    let sign_total = tgas(sign.total_gas_burnt);
    println!("GAS sign_payout (signer + callback): {sign_total:.1} Tgas");
    assert!(close_total <= 300.0 && sign_total <= 300.0);
    let report = json!({"close_season_tgas": (close_total * 10.0).round() / 10.0, "sign_payout_tgas": (sign_total * 10.0).round() / 10.0, "tx_budget_tgas": 300.0});
    std::fs::write(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gas-report-bell.json"), serde_json::to_string_pretty(&report)? + "\n")?;
    Ok(())
}
