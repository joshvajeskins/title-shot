#![allow(unused_must_use)]
//! Adversarial review measurement (MEDIUM, fixed): who pays for the permanent storage that every challenge,
//! fight and fighter leaves behind? Equity = contract balance - storage staking - everything it owes
//! (balances + protocol balance + season side-pot), computed here from the public views, independently of the
//! contract's own `get_solvency`. Before the fix the equity fell with every bout (the endowment paid for players'
//! storage); now the toll's storage component pays for it, so the equity must not fall at all.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::json;
use titleshot_it::flows::Arena;
use titleshot_it::simx::archetype;
use titleshot_it::util::*;
use titleshot_it::world::World;

const STORAGE_BYTE_COST: i128 = 10_000_000_000_000_000_000; // 1e19 yocto per byte

async fn equity(w: &World, belt: u32) -> Result<(i128, u64)> {
    let acct = w.ts.view_account().await?;
    let mut owed: u128 = 0;
    for a in [&w.alice, &w.bob, &w.carol, &w.promoter, &w.owner] {
        owed += w.bal(a).await?;
    }
    let st = w.stats().await?;
    owed += u(&st["protocol_balance"]);
    owed += u(&w.season(belt).await?["side_pot"]);
    let storage = acct.storage_usage;
    Ok((acct.balance.as_yoctonear() as i128 - storage as i128 * STORAGE_BYTE_COST - owed as i128, storage))
}

#[tokio::test]
async fn equity_never_falls_per_bout_because_the_toll_pays_the_storage_it_creates() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol] {
        w.deposit(a, 3 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let names = ["raccoon running a casino", "cat who has already knocked", "mime trapped", "disco ball", "dragon who only collects socks"];
    let f: Vec<_> = names.iter().map(|n| archetype(n)).collect();
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let belt = arena.belt;
    let (e0, s0) = equity(&w, belt).await?;
    for (i, who) in [&w.bob, &w.carol, &w.bob, &w.carol, &w.bob].into_iter().enumerate() {
        arena.fight(who, (&f[i].0, &f[i].1), Winner::Champion).await?.assert_as_asked();
    }
    let (e1, s1) = equity(&w, belt).await?;
    let per = (e1 - e0) / 5;
    println!(
        "EQUITY over 5 bouts (new fighter each): {:+.5} NEAR total, {:+.5} NEAR per bout; storage +{} B ({} B per bout = {:.5} NEAR); mock OutLayer keeps {:.4} NEAR of the {:.4} NEAR fee",
        e1 as f64 / 1e24 - e0 as f64 / 1e24,
        per as f64 / 1e24,
        s1 - s0,
        (s1 - s0) / 5,
        ((s1 - s0) / 5) as f64 * 1e19 / 1e24,
        w.opts.charge as f64 / 1e24,
        w.opts.forge_fee as f64 / 1e24
    );
    let _ = json!({});
    assert!(e1 - e0 >= 0, "contract equity fell over 5 bouts: {} yocto (the endowment is paying for players' storage)", e1 - e0);
    Ok(())
}
