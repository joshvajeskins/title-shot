#![allow(unused_must_use)]
//! Test 11: the bell. close_season guards, zero-challenge refund, purse split with caps, side-pot credit.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use titleshot_it::expect;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, vrf_from};
use titleshot_it::util::*;
use titleshot_it::world::World;

const PURSE: u128 = 10_000_000_000_000_000; // 0.01 ETH in wei

fn payouts_by_payee(v: &Value) -> BTreeMap<String, u128> {
    let mut m = BTreeMap::new();
    for p in v.as_array().unwrap() {
        *m.entry(p["payee"].as_str().unwrap().to_string()).or_insert(0) += u(&p["amount_wei"]);
    }
    m
}

#[tokio::test]
async fn close_season_before_the_bell_is_refused_and_challenges_after_the_bell_are_refused() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, _) = archetype("raccoon running a casino");
    let arena = Arena::open(&w, (&o_s, &o_raw), 120, PURSE).await?;
    let r = w.call(&w.carol, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    assert_code(&r, "E_TOO_EARLY", "close before the bell");
    assert_eq!(w.view("get_belt", json!({"id": arena.belt})).await?["season"]["state"], "Open");
    w.advance_secs(125).await?;
    let late = w.call(&w.bob, "challenge", json!({"belt_id": arena.belt, "sentence": x_s}), 0).await?;
    assert_code(&late, "E_NO_SEASON", "challenge after the bell");
    assert_eq!(w.bal(&w.bob).await?, NEAR - ACCOUNT_STORAGE, "no toll taken after the bell");
    Ok(())
}

#[tokio::test]
async fn close_season_with_a_forging_challenge_is_refused_until_it_resolves_then_closes() -> Result<()> {
    let w = World::new().await?;
    w.ol.call("set_hold").args_json(json!({"hold": true})).transact().await?.into_result()?;
    w.deposit(&w.bob, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let arena = Arena::open(&w, (&o_s, &o_raw), 240, PURSE).await?;
    let (st, req, id) = w.start_challenge(&w.bob, arena.belt, &x_s).await?;
    w.advance_secs(250).await?; // past the bell, the forge is still out
    let r = w.call(&w.carol, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    assert_code(&r, "E_PENDING_BOUTS", "close while a challenge is forging");
    assert_eq!(w.view("get_belt", json!({"id": arena.belt})).await?["season"]["state"], "Open");
    // the forge answers: the bout still resolves (the season was not closed yet)
    w.answer(req, &w.ai.good(&x_s, &x_raw, &vrf_from(31))).await?;
    w.finish(st, id).await?;
    assert_eq!(w.challenge_view(id).await?["status"], "Resolved");
    let closed = w.ok(&w.carol, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    assert!(closed.is_success());
    assert_eq!(w.view("get_belt", json!({"id": arena.belt})).await?["season"]["state"], "Closed");
    Ok(())
}

#[tokio::test]
async fn close_season_twice_is_refused_and_creates_no_second_payout_plan() -> Result<()> {
    let w = World::new().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 60, PURSE).await?;
    w.advance_secs(65).await?;
    w.ok(&w.carol, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    let before = w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?;
    let again = w.call(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    assert_code(&again, "E_CLOSED", "second close");
    assert_eq!(w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?, before, "payout plan unchanged");
    let unknown = w.call(&w.bob, "close_season", json!({"belt_id": 77}), 0).await?;
    assert_code(&unknown, "E_NO_BELT", "unknown belt");
    Ok(())
}

#[tokio::test]
async fn zero_challenge_season_returns_the_whole_purse_to_the_promoter() -> Result<()> {
    let w = World::new().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 60, PURSE).await?;
    w.advance_secs(65).await?;
    let r = w.ok(&w.carol, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    let ids = r.json::<Vec<u64>>()?;
    let payouts = w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?;
    let plan = payouts_by_payee(&payouts);
    assert_eq!(plan, BTreeMap::from([(w.promoter.id().to_string(), PURSE)]), "100% of the purse back to the promoter: {payouts}");
    assert_eq!(payouts.as_array().unwrap().len(), 1);
    assert_eq!(ids.len(), 1, "close_season returns the payout ids");
    assert_eq!(payouts[0]["id"], ids[0]);
    assert!(payouts[0]["raw_tx"].is_null() && payouts[0]["nonce"].is_null(), "nothing signed yet");
    let s = w.season(arena.belt).await?;
    assert_eq!(s["state"], "Closed");
    assert_eq!(u(&s["side_pot"]), 0);
    Ok(())
}

#[tokio::test]
async fn purse_split_is_half_to_final_holder_half_pro_rata_capped_25_percent_remainder_to_holder_and_side_pot_to_holder() -> Result<()> {
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
    // promoter defends twice, alice takes the belt, defends once, carol takes it and holds it at the bell
    let plan = [(&w.bob, Winner::Champion), (&w.carol, Winner::Champion), (&w.alice, Winner::Challenger), (&w.bob, Winner::Champion), (&w.carol, Winner::Challenger)];
    for (i, (who, want)) in plan.into_iter().enumerate() {
        let b = arena.fight(who, (&f[i].0, &f[i].1), want).await?;
        b.assert_as_asked();
    }
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt["holder"], w.carol.id().to_string());
    let season = &belt["season"];
    assert_eq!(season["bouts"], 5);
    let dc: BTreeMap<String, u64> = season["defence_count"].as_array().unwrap().iter().map(|d| (d["account"].as_str().unwrap().to_string(), d["defences"].as_u64().unwrap())).collect();
    assert_eq!(dc, BTreeMap::from([(w.promoter.id().to_string(), 2), (w.alice.id().to_string(), 1)]), "successful defences per holder");
    let side_pot = u(&season["side_pot"]);
    let want_pot: u128 = arena.bouts.iter().map(|b| b.split(w.opts.toll, w.opts.forge_fee).side_pot).sum();
    assert_eq!(side_pot, want_pot, "side-pot = 10% of each toll after the forge fee and the storage component");
    w.advance_secs(900).await?;
    let carol_before = w.bal(&w.carol).await?;
    let r = w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    let ids = r.json::<Vec<u64>>()?;
    let payouts = w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?;
    let got = payouts_by_payee(&payouts);
    let want: BTreeMap<String, u128> =
        expect::purse(PURSE, 5, w.promoter.id().as_str(), w.carol.id().as_str(), &[(w.promoter.id().as_str(), 2), (w.alice.id().as_str(), 1)]).into_iter().collect();
    assert_eq!(got, want, "purse plan {payouts}");
    assert_eq!(got.values().sum::<u128>(), PURSE, "the plan sums to the purse exactly");
    assert_eq!(got[w.promoter.id().as_str()], PURSE / 4, "the promoter's pro-rata share (2/3 of the pool) is capped at 25% of the purse");
    assert!(got[w.alice.id().as_str()] < PURSE / 4);
    assert_eq!(ids.len(), got.len(), "one payout per payee");
    assert_eq!(w.bal(&w.carol).await?, carol_before + side_pot, "the side-pot NEAR goes to the final holder's balance");
    let s = w.season(arena.belt).await?;
    assert_eq!(s["state"], "Closed");
    assert_eq!(s["final_holder"], w.carol.id().to_string());
    // belt stays with the holder; a fresh season starts sealed with its own purse path
    let token: Value = w.ts.view("nft_token").args_json(json!({"token_id": format!("belt-{}", arena.belt)})).await?.json()?;
    assert_eq!(token["owner_id"], w.carol.id().to_string(), "closing a season does not move the belt");
    let (n_s, n_raw) = archetype("lighthouse");
    w.open_season(arena.belt, &n_s, &n_raw, 600, PURSE).await?;
    let s2 = w.season(arena.belt).await?;
    assert_eq!(s2["sealed"], true, "rule sealed again in the new season: {s2}");
    assert_eq!(s2["purse"]["path"], "belt-1-s2");
    assert_eq!(u(&s2["side_pot"]), 0);
    assert_eq!(s2["defence_count"].as_array().unwrap().len(), 0);
    Ok(())
}

#[tokio::test]
async fn open_season_guards_promoter_only_one_open_season_and_duration_bounds() -> Result<()> {
    let w = World::new().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (n_s, _) = archetype("grumpy mountain");
    let belt = w.create_belt().await?;
    let args = |d: u64| json!({"belt_id": belt, "opener_sentence": o_s, "duration_sec": d, "purse_wei": "1000"});
    let fee = w.opts.forge_fee;
    assert_code(&w.call(&w.bob, "open_season", args(120), fee).await?, "E_NOT_PROMOTER", "a stranger opening a season");
    assert_code(&w.call(&w.owner, "open_season", args(120), fee).await?, "E_NOT_PROMOTER", "even the owner is not the promoter");
    assert_code(&w.call(&w.promoter, "open_season", args(59), fee).await?, "E_DURATION", "59 seconds");
    assert_code(&w.call(&w.promoter, "open_season", args(30 * 86_400 + 1), fee).await?, "E_DURATION", "30 days + 1 second");
    assert_code(&w.call(&w.promoter, "open_season", json!({"belt_id": 99, "opener_sentence": o_s, "duration_sec": 120, "purse_wei": "1"}), fee).await?, "E_NO_BELT", "unknown belt");
    // boundaries are accepted
    w.open_season(belt, &o_s, &o_raw, 30 * 86_400, 1000).await?;
    assert_eq!(w.view("get_belt", json!({"id": belt})).await?["season"]["duration_sec"], 30 * 86_400);
    // a second season while one is open
    let r = w.call(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": n_s, "duration_sec": 120, "purse_wei": "1"}), fee).await?;
    assert_code(&r, "E_SEASON_OPEN", "second season while the first is open");
    Ok(())
}

#[tokio::test]
async fn failed_opener_forge_aborts_the_season_leaves_no_champion_and_the_promoter_can_retry() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, _) = archetype("raccoon running a casino");
    let belt = w.create_belt().await?;
    let prev = w.last_request().await?;
    let st = w
        .promoter
        .call(w.ts.id(), "open_season")
        .args_json(json!({"belt_id":belt,"opener_sentence":o_s,"duration_sec":3600,"purse_wei":"1000"}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(w.opts.forge_fee))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact_async()
        .await?;
    let req = w.wait_request(prev).await?;
    let id = w.request_input(req).await?["challenge_id"].as_u64().unwrap();
    w.fail_request(req).await?;
    w.finish(st, id).await?;
    let b = w.view("get_belt", json!({"id": belt})).await?;
    assert!(b["champion"].is_null(), "a failed opener never becomes champion: {b}");
    assert_ne!(b["season"]["state"], "Open", "no open season without a champion: {b}");
    let r = w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?;
    assert!(r.is_failure(), "nobody can challenge a belt with no champion");
    // retry works
    w.open_season(belt, &o_s, &o_raw, 3600, 1000).await?;
    assert_eq!(w.view("get_belt", json!({"id": belt})).await?["season"]["state"], "Open");
    Ok(())
}
