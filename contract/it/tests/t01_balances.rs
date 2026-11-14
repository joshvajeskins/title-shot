#![allow(unused_must_use)]
//! Test 1: deposit / withdraw / storage reserve, to the yocto.
use anyhow::Result;
use serde_json::json;
use titleshot_it::util::*;
use titleshot_it::world::{World, U};

#[tokio::test]
async fn first_deposit_keeps_the_storage_reserve_and_credits_the_rest_to_the_yocto() -> Result<()> {
    let w = World::new().await?;
    let amount = NEAR + 123_456_789; // odd yocto on purpose
    w.deposit(&w.alice, amount).await?;
    assert_eq!(w.bal(&w.alice).await?, amount - ACCOUNT_STORAGE, "first deposit: amount - 0.005 NEAR reserve");
    // later deposits credit in full (the reserve is paid once per account)
    w.deposit(&w.alice, 7 * MILLI + 1).await?;
    assert_eq!(w.bal(&w.alice).await?, amount - ACCOUNT_STORAGE + 7 * MILLI + 1);
    let st = w.stats().await?;
    assert_eq!(u(&st["deposits"]), amount - ACCOUNT_STORAGE + 7 * MILLI + 1, "stats.deposits counts credited NEAR");
    assert_eq!(w.bal(&w.bob).await?, 0, "an account that never deposited has zero balance");
    Ok(())
}

#[tokio::test]
async fn deposit_below_the_storage_reserve_is_refused_and_credits_nothing() -> Result<()> {
    let w = World::new().await?;
    let r = w.call(&w.alice, "deposit", json!({}), ACCOUNT_STORAGE - 1).await?;
    assert_code(&r, "E_STORAGE", "deposit of 0.005 NEAR minus 1 yocto");
    assert_eq!(w.bal(&w.alice).await?, 0);
    let r0 = w.call(&w.alice, "deposit", json!({}), 0).await?;
    assert!(r0.is_failure(), "a zero deposit must not create an account entry");
    assert_eq!(w.bal(&w.alice).await?, 0);
    Ok(())
}

#[tokio::test]
async fn deposit_for_credits_the_guest_not_the_sponsor_and_applies_the_same_storage_rule() -> Result<()> {
    let w = World::new().await?;
    w.ok(&w.alice, "deposit_for", json!({"account": w.bob.id()}), NEAR).await?;
    assert_eq!(w.bal(&w.bob).await?, NEAR - ACCOUNT_STORAGE, "guest gets the amount minus the one-time reserve");
    assert_eq!(w.bal(&w.alice).await?, 0, "the sponsor's own balance is untouched");
    let r = w.call(&w.alice, "deposit_for", json!({"account": w.carol.id()}), ACCOUNT_STORAGE - 1).await?;
    assert_code(&r, "E_STORAGE", "sponsoring a new guest below the reserve");
    assert_eq!(w.bal(&w.carol).await?, 0);
    // topping up an existing guest is a plain credit
    w.ok(&w.alice, "deposit_for", json!({"account": w.bob.id()}), MILLI).await?;
    assert_eq!(w.bal(&w.bob).await?, NEAR - ACCOUNT_STORAGE + MILLI);
    Ok(())
}

#[tokio::test]
async fn withdraw_needs_exactly_one_yocto_and_moves_exactly_the_amount() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.alice, 10 * NEAR).await?;
    let start = w.bal(&w.alice).await?;
    // no deposit / two yocto: refused, nothing moves
    for dep in [0u128, 2] {
        let r = w.call(&w.alice, "withdraw", json!({"amount": U(NEAR)}), dep).await?;
        assert!(r.is_failure(), "withdraw with {dep} yocto attached must fail");
        assert_eq!(w.bal(&w.alice).await?, start);
    }
    let native0 = w.native(&w.alice).await?;
    w.ok(&w.alice, "withdraw", json!({"amount": U(3 * NEAR)}), 1).await?;
    // let the transfer receipt land
    for _ in 0..20 {
        if w.native(&w.alice).await? > native0 + 2 * NEAR {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(w.bal(&w.alice).await?, start - 3 * NEAR, "internal balance drops by exactly the amount");
    let gained = w.native(&w.alice).await? as i128 - native0 as i128;
    assert!(gained > 3 * NEAR as i128 - 400 * MILLI as i128 && gained < 3 * NEAR as i128, "native account received ~3 NEAR (minus prepaid gas that is refunded later, and the 1 yocto): {gained}");
    assert_eq!(u(&w.stats().await?["withdrawn"]), 3 * NEAR);
    Ok(())
}

#[tokio::test]
async fn withdraw_all_empties_the_balance_and_overdraw_or_empty_withdraw_is_refused() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.alice, 2 * NEAR).await?;
    let bal = w.bal(&w.alice).await?;
    let r = w.call(&w.alice, "withdraw", json!({"amount": U(bal + 1)}), 1).await?;
    assert_code(&r, "E_BALANCE", "overdraw by one yocto");
    assert_eq!(w.bal(&w.alice).await?, bal);
    let r = w.call(&w.alice, "withdraw", json!({"amount": U(0)}), 1).await?;
    assert!(r.is_failure(), "withdrawing zero must be refused");
    w.ok(&w.alice, "withdraw", json!({"amount": null}), 1).await?;
    assert_eq!(w.bal(&w.alice).await?, 0, "amount = null withdraws everything");
    let r = w.call(&w.alice, "withdraw", json!({"amount": null}), 1).await?;
    assert!(r.is_failure(), "withdrawing from an empty balance must be refused");
    let r = w.call(&w.bob, "withdraw", json!({"amount": U(1)}), 1).await?;
    assert_code(&r, "E_BALANCE", "an account that never deposited");
    assert_eq!(u(&w.stats().await?["withdrawn"]), bal);
    Ok(())
}

#[tokio::test]
async fn contract_native_balance_always_covers_every_internal_balance() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.alice, 5 * NEAR).await?;
    w.deposit(&w.bob, 3 * NEAR + 17).await?;
    w.ok(&w.alice, "withdraw", json!({"amount": U(2 * NEAR)}), 1).await?;
    let owed = w.bal(&w.alice).await? + w.bal(&w.bob).await?;
    let held = w.native(&w.ts.as_account().clone()).await?;
    assert!(held > owed, "contract holds {held} but owes {owed}");
    Ok(())
}
