#![allow(unused_must_use)]
//! Test 25: the NEAR AI compile cap (docs/BUDGET.md) on the real wasm. A compile is counted when it is requested; once the
//! UTC-day or the total cap is reached a sentence that needs one is refused `E_FORGE_CLOSED` before any toll is debited,
//! a cached sentence always plays, the daily counter rolls over with the block timestamp, the owner resets the counter.
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use titleshot_it::simx::{archetypes, vrf_from};
use titleshot_it::util::*;
use titleshot_it::world::{Opts, World, U};

const DAY_NS: u64 = 86_400 * 1_000_000_000;

async fn relayer_world() -> Result<(World, Vec<(String, Value)>)> {
    let w = World::with(Opts { forge_mode: "relayer", delay_sec: 0, ..Opts::default() }).await?;
    w.add_relayer().await?;
    Ok((w, archetypes()))
}

async fn caps(w: &World) -> Result<Value> {
    w.view("get_compile_caps", json!({})).await
}

/// A challenge that needs a compile, delivered by the relayer. Returns the challenge id.
async fn challenge_compiled(w: &World, who: &near_workspaces::Account, belt: u32, (s, raw): &(String, Value), tag: u64) -> Result<u64> {
    let r = w.ok(who, "challenge", json!({"belt_id": belt, "sentence": s}), 0).await?;
    let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?["challenge_id"].as_u64().unwrap();
    let sub = w.submit_forge(&w.relayer, id, &w.ai.good(s, raw, &vrf_from(tag))).await?;
    assert!(sub.is_success(), "{}", failure_text(&sub));
    assert_eq!(w.challenge_view(id).await?["status"], "Resolved");
    Ok(id)
}

#[tokio::test]
async fn the_cap_refuses_new_compiles_before_the_toll_and_cached_sentences_and_the_reset_reopen_play() -> Result<()> {
    let (w, a) = relayer_world().await?;
    let c = caps(&w).await?;
    assert_eq!((c["daily"].clone(), c["total"].clone(), c["used"].clone()), (json!(60), json!(250), json!(0)), "defaults at new()");
    assert_code(&w.call(&w.bob, "set_compile_caps", json!({"daily": 9, "total": 9}), 1).await?, "E_NOT_OWNER", "non-owner caps");
    assert_code(&w.call(&w.owner, "set_compile_caps", json!({"daily": 9, "total": 9}), 0).await?, "yocto", "caps need 1 yocto");
    w.ok(&w.owner, "set_compile_caps", json!({"daily": 60, "total": 2}), 1).await?;
    let belt = w.create_belt().await?;
    w.open_season_relayer(belt, &a[0].0, &a[0].1, 3600, 0).await?; // compile 1
    for p in [&w.alice, &w.bob, &w.carol] {
        w.deposit(p, NEAR).await?;
    }
    challenge_compiled(&w, &w.alice, belt, &a[1], 11).await?; // compile 2
    let c = caps(&w).await?;
    assert_eq!((c["today"].clone(), c["used"].clone(), c["open"].clone()), (json!(2), json!(2), json!(false)));
    // A sentence that needs a compile: refused, nothing debited, no challenge created.
    let (bal, tolls) = (w.bal(&w.bob).await?, w.stats().await?["tolls"].clone());
    let r = w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": a[2].0}), 0).await?;
    assert_code(&r, "E_FORGE_CLOSED", "total cap reached");
    assert_eq!((w.bal(&w.bob).await?, w.stats().await?["tolls"].clone()), (bal, tolls), "no toll debited");
    assert!(w.view("get_pending", json!({"account": w.bob.id()})).await?.is_null());
    // A cached sentence (already forged, not the champion's) needs no compile: it plays and is not counted.
    let holder = w.view("get_belt", json!({"id": belt})).await?["holder"].clone();
    let cached = if holder == json!(w.alice.id()) { &a[0] } else { &a[1] };
    let r = w.ok(&w.bob, "challenge", json!({"belt_id": belt, "sentence": cached.0}), 0).await?;
    let id = event(&r, "forge_requested").unwrap()["challenge_id"].as_u64().unwrap();
    assert_eq!(event(&r, "forge_requested").unwrap()["need_compile"], false);
    assert!(w.submit_forge(&w.relayer, id, &w.ai.vrf_only(&vrf_from(12))).await?.is_success());
    assert_eq!(w.challenge_view(id).await?["status"], "Resolved");
    assert_eq!(caps(&w).await?["used"], 2, "a cached sentence is not counted");
    // The bell, then a new opener sentence is refused; a cached opener opens at once.
    w.advance_secs(3605).await?;
    w.ok(&w.carol, "close_season", json!({"belt_id": belt}), 0).await?;
    let r = w.call(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": a[3].0, "duration_sec": 3600, "purse_wei": U(0)}), w.opts.forge_fee).await?;
    assert_code(&r, "E_FORGE_CLOSED", "new opener refused");
    w.ok(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": a[0].0, "duration_sec": 3600, "purse_wei": U(0)}), w.opts.forge_fee).await?;
    assert_eq!(w.season(belt).await?["state"], "Open", "cached opener opened without a forge");
    // Key rotation: the owner resets the counter and new compiles flow again.
    assert_code(&w.call(&w.bob, "reset_compile_counter", json!({}), 1).await?, "E_NOT_OWNER", "non-owner reset");
    w.ok(&w.owner, "reset_compile_counter", json!({}), 1).await?;
    assert_eq!((caps(&w).await?["used"].clone(), caps(&w).await?["today"].clone()), (json!(0), json!(0)));
    challenge_compiled(&w, &w.carol, belt, &a[2], 13).await?;
    assert_eq!(caps(&w).await?["used"], 1);
    Ok(())
}

/// The compile cap is the last field of the contract's `STATE` record: daily u32, total u32, day u64, today u32, used u32.
async fn cap_tail(w: &World) -> Result<(Vec<u8>, [u8; 24])> {
    let st = w.w.view_state(w.ts.id()).prefix(b"STATE").await?;
    let v = st.get(b"STATE".as_slice()).cloned().ok_or_else(|| anyhow!("no STATE"))?;
    let tail: [u8; 24] = v[v.len() - 24..].try_into()?;
    Ok((v, tail))
}

#[tokio::test]
async fn the_daily_counter_rolls_over_when_the_block_timestamp_reaches_a_new_utc_day() -> Result<()> {
    // Waiting for a real UTC midnight would take the sandbox over an hour of fast-forwarding, so the stored counter is
    // moved to yesterday instead: the contract must compare it with the day of the block timestamp and start afresh.
    let (w, a) = relayer_world().await?;
    w.ok(&w.owner, "set_compile_caps", json!({"daily": 1, "total": 100}), 1).await?;
    let belt = w.create_belt().await?;
    w.open_season_relayer(belt, &a[0].0, &a[0].1, 30 * 86_400, 0).await?; // today's only compile
    w.deposit(&w.alice, NEAR).await?;
    let r = w.call(&w.alice, "challenge", json!({"belt_id": belt, "sentence": a[1].0}), 0).await?;
    assert_code(&r, "E_FORGE_CLOSED", "daily cap reached");
    let c = caps(&w).await?;
    let day0 = c["day"].as_u64().unwrap();
    assert_eq!(day0, w.now_ns().await? / DAY_NS, "day index comes from the block timestamp");
    let (mut state, tail) = cap_tail(&w).await?;
    let le32 = |b: &[u8]| u32::from_le_bytes(b.try_into().unwrap());
    assert_eq!((le32(&tail[0..4]), le32(&tail[4..8]), u64::from_le_bytes(tail[8..16].try_into()?), le32(&tail[16..20]), le32(&tail[20..24])), (1, 100, day0, 1, 1), "stored layout");
    let n = state.len();
    state[n - 16..n - 8].copy_from_slice(&(day0 - 1).to_le_bytes());
    w.w.patch_state(w.ts.id(), b"STATE", &state).await?;
    let c = caps(&w).await?;
    assert_eq!((c["day"].as_u64(), c["today"].clone(), c["used"].clone(), c["open"].clone()), (Some(day0), json!(0), json!(1), json!(true)), "a new UTC day: {c}");
    challenge_compiled(&w, &w.alice, belt, &a[1], 21).await?;
    let c = caps(&w).await?;
    assert_eq!((c["day"].as_u64(), c["today"].clone(), c["used"].clone(), c["open"].clone()), (Some(day0), json!(1), json!(2), json!(false)));
    assert_eq!(u64::from_le_bytes(cap_tail(&w).await?.1[8..16].try_into()?), day0, "the counter now records today");
    Ok(())
}
