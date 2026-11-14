#![allow(unused_must_use)]
//! Test 2: a function-call key (receiver = contract) can play but cannot touch money or ownership.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::json;
use titleshot_it::flows::Arena;
use titleshot_it::simx::archetype;
use titleshot_it::util::*;
use titleshot_it::world::{World, U};

#[tokio::test]
async fn fc_key_limited_to_challenge_can_challenge_but_nothing_else() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.alice, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (c_s, c_raw) = archetype("raccoon running a casino");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let fc = w.fc_key(&w.alice, &["challenge"]).await?;
    let before = w.bal(&w.alice).await?;
    // 1) the key can challenge (no popup, no deposit)
    let b = arena.fight(&fc, (&c_s, &c_raw), Winner::Champion).await?;
    assert!(b.run.res.is_success(), "challenge via FC key: {}", failure_text(&b.run.res));
    let ch = w.challenge_view(b.run.id).await?;
    assert_eq!(ch["challenger"], w.alice.id().to_string(), "the account behind the key is the challenger");
    assert_eq!(w.bal(&w.alice).await?, before - w.opts.toll);
    // 2) every other method is refused by the network: wrong method for this key
    let bal = w.bal(&w.alice).await?;
    let attempts = [
        ("withdraw", json!({"amount": U(NEAR / 10)}), 1u128),
        ("withdraw", json!({"amount": null}), 0),
        ("set_evm_address", json!({"addr": "0x00000000000000000000000000000000000000aa"}), 1),
        ("deposit", json!({}), 0),
        ("open_season", json!({"belt_id":1,"opener_sentence":"a thief in a pinstripe suit","duration_sec":120,"purse_wei":"1"}), 0),
    ];
    for (m, args, dep) in attempts {
        let r = fc.call(w.ts.id(), m).args_json(args).deposit(near_workspaces::types::NearToken::from_yoctonear(dep)).transact().await;
        assert!(r.is_err() || r.as_ref().unwrap().is_failure(), "FC key must not run {m}: {r:?}");
    }
    let r = fc
        .call(w.ts.id(), "nft_transfer")
        .args_json(json!({"receiver_id": w.bob.id(), "token_id": format!("belt-{}", arena.belt)}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(r.is_err() || r.as_ref().unwrap().is_failure(), "FC key must not transfer the belt: {r:?}");
    assert_eq!(w.bal(&w.alice).await?, bal, "no money moved");
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt["holder"], w.promoter.id().to_string());
    Ok(())
}

#[tokio::test]
async fn fc_key_allowed_every_method_still_cannot_move_money_or_the_belt() -> Result<()> {
    // methods = [] means "any method of the contract": the contract's own guards (1 yocto, promoter, owner) must hold
    // because a function-call key can never attach a deposit.
    let w = World::new().await?;
    w.deposit(&w.alice, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let fc = w.fc_key(&w.alice, &[]).await?;
    let bal = w.bal(&w.alice).await?;
    let native0 = w.native(&w.alice).await?;
    // withdraw / set_evm_address / nft_transfer need exactly 1 yocto: a key cannot attach it
    let tries: Vec<(&str, serde_json::Value, u128)> = vec![
        ("withdraw", json!({"amount": U(NEAR / 10)}), 1),
        ("set_evm_address", json!({"addr": "0x00000000000000000000000000000000000000aa"}), 1),
        ("nft_transfer", json!({"receiver_id": w.bob.id(), "token_id": format!("belt-{}", arena.belt)}), 1),
    ];
    for (m, args, dep) in tries {
        let r = fc.call(w.ts.id(), m).args_json(args).deposit(near_workspaces::types::NearToken::from_yoctonear(dep)).transact().await;
        assert!(r.is_err(), "{m} with a deposit must be rejected before execution for a function-call key: {r:?}");
    }
    // without a deposit the contract's own guard must refuse them
    for (m, args) in [
        ("withdraw", json!({"amount": U(NEAR / 10)})),
        ("set_evm_address", json!({"addr": "0x00000000000000000000000000000000000000aa"})),
        ("nft_transfer", json!({"receiver_id": w.bob.id(), "token_id": format!("belt-{}", arena.belt)})),
    ] {
        let r = fc.call(w.ts.id(), m).args_json(args).transact().await?;
        assert!(r.is_failure(), "{m} without the 1 yocto must fail inside the contract");
        assert!(failure_text(&r).to_lowercase().contains("yocto") || failure_text(&r).contains("token"), "{m}: {}", failure_text(&r));
    }
    // open_season is promoter-only
    let r = fc.call(w.ts.id(), "open_season").args_json(json!({"belt_id":arena.belt,"opener_sentence":"a thief in a pinstripe suit","duration_sec":120,"purse_wei":"1"})).transact().await?;
    assert!(r.is_failure(), "open_season by a non-promoter key must fail");
    assert_eq!(w.bal(&w.alice).await?, bal);
    assert!(w.native(&w.alice).await? <= native0, "no NEAR left the contract");
    let token: serde_json::Value = w.ts.view("nft_token").args_json(json!({"token_id": format!("belt-{}", arena.belt)})).await?.json()?;
    assert_eq!(token["owner_id"], w.promoter.id().to_string(), "belt did not move");
    Ok(())
}
