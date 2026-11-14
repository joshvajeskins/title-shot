#![allow(unused_must_use)]
//! Test 21 (review fix, MEDIUM): storage is paid by the toll. On the real wasm, after many challenges the contract
//! is solvent: balance - locked storage - liabilities never falls, every byte the bouts stored was charged to a toll,
//! and a refused or failed forge does not drain the endowment either.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::json;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, archetypes};
use titleshot_it::util::*;
use titleshot_it::world::World;

fn equity(sol: &serde_json::Value) -> i128 {
    sol["equity"].as_str().unwrap().parse().unwrap()
}

#[tokio::test]
async fn after_many_challenges_equity_never_falls_and_every_stored_byte_was_charged_to_a_toll() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol] {
        w.deposit(a, 4 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let sol0 = w.view("get_solvency", json!({})).await?;
    assert!(equity(&sol0) >= 0, "a funded contract starts solvent: {sol0}");
    let usage0 = w.ts.view_account().await?.storage_usage;
    let mut seen = std::collections::HashSet::new();
    let pool: Vec<_> = archetypes()
        .into_iter()
        .filter(|(s, _)| *s != o_s && seen.insert(s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()))
        .take(11)
        .collect();
    let who = [&w.alice, &w.bob, &w.carol];
    let (mut charged, mut bytes, mut repeats) = (0u128, 0u64, 0);
    for (i, f) in pool.iter().enumerate() {
        // The last two challenges repeat an earlier sentence: a cached fighter, a smaller bill.
        let f = if i >= pool.len() - 2 { &pool[i - 8] } else { f };
        let b = arena.fight(who[i % 3], (&f.0, &f.1), Winner::Champion).await?;
        b.assert_as_asked();
        let sp = b.split(w.opts.toll, w.opts.forge_fee);
        assert_eq!(sp.champion + sp.promoter + sp.side_pot + sp.protocol + w.opts.forge_fee + b.storage(), w.opts.toll);
        charged += b.storage();
        bytes += b.fight["storage_bytes"].as_u64().unwrap();
        repeats += usize::from(!b.compiled);
    }
    assert_eq!(repeats, 2);
    let usage1 = w.ts.view_account().await?.storage_usage;
    let sol1 = w.view("get_solvency", json!({})).await?;
    let st = w.stats().await?;
    assert_eq!(u(&st["storage_charged"]), charged, "stats carry the sum of the storage components");
    assert_eq!(u(&sol1["storage_debt"]), 0, "no bout stored more than it could be charged: {sol1}");
    assert_eq!(sol1["players_covered"], true);
    // The bytes the bouts measured are the bytes the account really grew by (the balance entries of the three funded
    // accounts and the winner changes are the only other writes; allow a small constant for the state struct).
    let grown = usage1 - usage0;
    println!("STORAGE {} bouts: account grew {grown} B, bouts measured {bytes} B, charged {:.5} NEAR, equity {:+.5} -> {:+.5} NEAR",
        pool.len(), charged as f64 / 1e24, equity(&sol0) as f64 / 1e24, equity(&sol1) as f64 / 1e24);
    assert!(bytes + 300 >= grown && grown + 300 >= bytes, "measured {bytes} B vs real growth {grown} B");
    assert!(charged >= grown as u128 * 10u128.pow(19) - 3_000 * 10u128.pow(19), "the components pay for the growth");
    assert!(equity(&sol1) >= equity(&sol0), "equity fell: {} -> {}", equity(&sol0), equity(&sol1));
    Ok(())
}

#[tokio::test]
async fn failed_forges_do_not_drain_the_endowment_the_forge_fee_surplus_pays_their_records() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, 4 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let sol0 = w.view("get_solvency", json!({})).await?;
    for i in 0..6 {
        let sentence = format!("a doomed challenger number {i} with a loud hat");
        let (st, req, id) = w.start_challenge(&w.bob, arena.belt, &sentence).await?;
        w.fail_request(req).await?;
        w.finish(st, id).await?;
        assert_eq!(w.challenge_view(id).await?["status"], "Refunded");
    }
    let sol1 = w.view("get_solvency", json!({})).await?;
    println!("REFUNDS 6 failed forges: equity {:+.5} -> {:+.5} NEAR", equity(&sol0) as f64 / 1e24, equity(&sol1) as f64 / 1e24);
    assert!(equity(&sol1) >= equity(&sol0), "six failed forges drained the endowment: {sol0} -> {sol1}");
    assert_eq!(sol1["players_covered"], true);
    Ok(())
}
