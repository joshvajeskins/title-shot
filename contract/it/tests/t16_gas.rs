#![allow(unused_must_use)]
//! Gas report: worst-case `challenge` + `on_forged` from the sandbox (targets: callback <= 120 Tgas, whole tx tree
//! within the 300 Tgas a single transaction can attach). Writes contract/it/gas-report.json.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::json;
use titleshot_it::fixtures::Hostile;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, vrf_from};
use titleshot_it::util::*;
use titleshot_it::world::World;

const CALLBACK_TARGET_TGAS: f64 = 120.0;
const TX_BUDGET_TGAS: f64 = 300.0;

#[tokio::test]
async fn worst_case_challenge_and_callback_gas_stay_inside_the_budget() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol] {
        w.deposit(a, 3 * NEAR).await?;
    }
    let ts = w.ts.id().to_string();
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (belt, opener) = w.open_belt(&o_s, &o_raw, 3600, 10u128.pow(16)).await?;
    let mut rows = vec![];
    let mut row = |name: &str, run: &titleshot_it::world::Run| {
        let (total, cb) = (tgas(run.res.total_gas_burnt), run.callback_gas(&ts));
        println!("GAS {name:<46} tx tree {total:6.1} Tgas   callback {cb:6.1} Tgas");
        rows.push(json!({"path": name, "tx_tree_tgas": (total * 10.0).round() / 10.0, "callback_tgas": (cb * 10.0).round() / 10.0}));
        assert!(total <= TX_BUDGET_TGAS, "{name}: {total} Tgas over the 300 Tgas tx budget");
        assert!(cb <= CALLBACK_TARGET_TGAS, "{name}: callback {cb} Tgas over the {CALLBACK_TARGET_TGAS} Tgas target");
    };
    row("open_season (opener compile, no fight)", &opener);
    let mut arena = Arena::at(&w, belt, (&o_s, &o_raw), w.promoter.id().to_string());
    // first-ever compile + champion wins
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let b = arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?;
    row("challenge: compile + bout, champion wins", &b.run);
    // cached fighter (no compile), champion wins
    let b = arena.fight(&w.carol, (&x_s, &x_raw), Winner::Champion).await?;
    row("challenge: cached fighter + bout", &b.run);
    // compile + challenger wins: title change, NFT moves (the heaviest resolution)
    let (y_s, y_raw) = archetype("cat who has already knocked");
    let b = arena.fight(&w.alice, (&y_s, &y_raw), Winner::Challenger).await?;
    row("challenge: compile + bout, title change", &b.run);
    // rejected compile (signature check runs, then refund)
    let (z_s, z_raw) = archetype("grumpy mountain");
    let vrf = vrf_from(5);
    let run = w.run_challenge(&w.bob, belt, &z_s, |_| Hostile::tampered_response(&w.ai, &z_s, &z_raw, &vrf)).await?;
    row("challenge: tampered response -> refund", &run);
    // a real-size (3.4 KB) forge output: delivered through OutLayer's stored-output path, parsed and verified in full
    let (g_s, g_raw) = archetype("world's angriest goose");
    let run = w.run_challenge(&w.bob, belt, &g_s, |_| w.ai.good_padded(&g_s, &g_raw, &vrf_from(9), 2_300)).await?;
    assert!(w.request(run.req).await?["output"].as_str().unwrap().len() > 3_000);
    row("challenge: 3 KB forge output (stored-output path)", &run);
    let report = json!({"note": "gas burnt over the whole receipt tree (challenge tx incl. mock OutLayer + callback), sandbox, debug test binary, real wasm", "rows": rows,
        "callback_target_tgas": CALLBACK_TARGET_TGAS, "tx_budget_tgas": TX_BUDGET_TGAS});
    std::fs::write(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gas-report.json"), serde_json::to_string_pretty(&report)? + "\n")?;
    Ok(())
}
