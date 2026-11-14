#![allow(unused_must_use)]
//! Tests 4 and 6: forge failure / null / timeout paths refund toll minus fee; late and double callbacks are no-ops.
use anyhow::Result;
use serde_json::{json, Value};
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, vrf_from};
use titleshot_it::snap::{assert_refund_minus_fee, snap};
use titleshot_it::util::*;
use titleshot_it::world::{Opts, World};

async fn belt_with_bob() -> Result<(World, u32, (String, Value))> {
    let w = World::new().await?;
    w.deposit(&w.bob, NEAR).await?;
    w.deposit(&w.carol, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let belt = arena.belt;
    Ok((w, belt, archetype("raccoon running a casino")))
}

/// The challenge ended `Refunded`/`Rejected` with a code, and left no fight, no fighter, no pending lock.
async fn assert_clean_refund(w: &World, id: u64, sentence: &str, who: &near_workspaces::Account) -> Result<String> {
    let ch = w.challenge_view(id).await?;
    let status = ch["status"].as_str().unwrap_or("").to_string();
    assert!(status == "Refunded" || status == "Rejected", "status {status}: {ch}");
    let code = ch["code"].as_str().unwrap_or("").to_string();
    assert!(code.starts_with("E_"), "a refund must carry a stable code: {ch}");
    assert!(ch["fight_id"].is_null(), "no fight for a refunded challenge");
    assert!(w.view("get_pending", json!({"account": who.id()})).await?.is_null(), "pending lock cleared on every terminal status");
    assert!(w.view("get_fighter_by_sentence", json!({"sentence": sentence})).await?.is_null(), "a failed forge stores no fighter");
    let st = w.stats().await?;
    assert_eq!(st["bouts"], 0);
    Ok(code)
}

#[tokio::test]
async fn outlayer_execution_failure_refunds_toll_minus_fee_and_unlocks_the_account() -> Result<()> {
    let (w, belt, (s, _)) = belt_with_bob().await?;
    let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    let (st, req, id) = w.start_challenge(&w.bob, belt, &s).await?;
    assert!(!w.view("get_pending", json!({"account": w.bob.id()})).await?.is_null(), "pending while forging");
    w.fail_request(req).await?;
    let res = w.finish(st, id).await?;
    let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    assert_refund_minus_fee(&before, &after, w.opts.toll, w.opts.forge_fee, &w.bob);
    assert_clean_refund(&w, id, &s, &w.bob).await?;
    assert_eq!(count_events(&res, "refunded"), 1);
    // the account can play again immediately
    let (_st2, _req2, id2) = w.start_challenge(&w.bob, belt, &s).await?;
    assert_ne!(id2, id);
    Ok(())
}

#[tokio::test]
async fn outlayer_null_result_refunds_toll_minus_fee() -> Result<()> {
    let (w, belt, (s, _)) = belt_with_bob().await?;
    let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    let (st, req, id) = w.start_challenge(&w.bob, belt, &s).await?;
    assert!(w.answer_raw(req, "null").await?);
    w.finish(st, id).await?;
    let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    assert_refund_minus_fee(&before, &after, w.opts.toll, w.opts.forge_fee, &w.bob);
    assert_clean_refund(&w, id, &s, &w.bob).await?;
    Ok(())
}

#[tokio::test]
async fn outlayer_yield_timeout_failed_promise_refunds_toll_minus_fee() -> Result<()> {
    let (w, belt, (s, _)) = belt_with_bob().await?;
    let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    let (st, _req, id) = w.start_challenge(&w.bob, belt, &s).await?;
    w.w.fast_forward(260).await?; // OutLayer never answers: the yield times out after 200 blocks
    w.finish(st, id).await?;
    let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    assert_refund_minus_fee(&before, &after, w.opts.toll, w.opts.forge_fee, &w.bob);
    assert_clean_refund(&w, id, &s, &w.bob).await?;
    Ok(())
}

#[tokio::test]
async fn unparsable_or_oversized_or_error_outputs_refund_instead_of_resolving() -> Result<()> {
    let (w, belt, (s, _)) = belt_with_bob().await?;
    let cases: Vec<(&str, String)> = vec![
        ("not json", "this is not json".to_string()),
        ("forge says ok:false", json!({"ok":false,"code":"E_AI_STATUS","detail":"401 invalid key"}).to_string()),
        ("json array", "[1,2,3]".to_string()),
        ("over 16 KB", json!({"ok":true,"junk":"x".repeat(20_000)}).to_string()),
        ("ok but no vrf, no ai", json!({"ok":true}).to_string()),
    ];
    for (name, out) in cases {
        let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
        let (st, req, id) = w.start_challenge(&w.bob, belt, &s).await?;
        assert!(w.answer_raw(req, &out).await?, "{name}: delivered");
        w.finish(st, id).await?;
        let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
        assert_refund_minus_fee(&before, &after, w.opts.toll, w.opts.forge_fee, &w.bob);
        assert_clean_refund(&w, id, &s, &w.bob).await.map_err(|e| anyhow::anyhow!("{name}: {e}"))?;
    }
    Ok(())
}

#[tokio::test]
async fn stuck_forge_can_be_expired_by_anyone_only_after_ten_minutes_with_refund_minus_fee() -> Result<()> {
    let (w, belt, (s, _)) = belt_with_bob().await?;
    w.ol.call("set_hold").args_json(json!({"hold": true})).transact().await?.into_result()?;
    let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    let (_st, _req, id) = w.start_challenge(&w.bob, belt, &s).await?;
    let early = w.call(&w.carol, "expire_challenge", json!({"id": id}), 0).await?;
    assert_code(&early, "E_TOO_EARLY", "expire right away");
    assert_eq!(w.challenge_view(id).await?["status"], "Forging");
    w.advance_secs(540).await?;
    let still = w.call(&w.carol, "expire_challenge", json!({"id": id}), 0).await?;
    assert_code(&still, "E_TOO_EARLY", "expire at 9 minutes");
    w.advance_secs(75).await?; // past 10 minutes
    let done = w.ok(&w.carol, "expire_challenge", json!({"id": id}), 0).await?;
    assert_eq!(done.json::<bool>()?, true, "expired");
    let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    assert_refund_minus_fee(&before, &after, w.opts.toll, w.opts.forge_fee, &w.bob);
    assert_clean_refund(&w, id, &s, &w.bob).await?;
    // a second expiry is a soft no-op: no second refund
    let again = w.ok(&w.carol, "expire_challenge", json!({"id": id}), 0).await?;
    assert_eq!(again.json::<bool>()?, false);
    assert_eq!(snap(&w, belt, &[&w.bob, &w.promoter]).await?.bal, after.bal, "no double refund");
    Ok(())
}

#[tokio::test]
async fn late_answer_after_expiry_is_a_no_op_no_second_refund_no_fight_no_fighter() -> Result<()> {
    let (w, belt, (s, raw)) = belt_with_bob().await?;
    w.ol.call("set_hold").args_json(json!({"hold": true})).transact().await?.into_result()?;
    let (st, req, id) = w.start_challenge(&w.bob, belt, &s).await?;
    w.advance_secs(615).await?;
    w.ok(&w.carol, "expire_challenge", json!({"id": id}), 0).await?;
    let after_expiry = snap(&w, belt, &[&w.bob, &w.promoter, &w.carol]).await?;
    // OutLayer finally answers with a perfectly valid, signed compile
    let good = w.ai.good(&s, &raw, &vrf_from(77));
    assert!(w.answer(req, &good).await?, "the held yield is still alive, so the late answer is delivered");
    // let the callback run (a few blocks), then look at the logs of the whole tx tree if the node serves them
    w.w.fast_forward(20).await?;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let res = w.settled_within(st, 3).await;
    let after_late = snap(&w, belt, &[&w.bob, &w.promoter, &w.carol]).await?;
    assert_eq!(after_late.bal, after_expiry.bal, "late callback must not move any balance");
    assert_eq!(after_late.side_pot, after_expiry.side_pot);
    assert_eq!(after_late.protocol, after_expiry.protocol);
    if let Some(res) = res {
        assert_eq!(count_events(&res, "bout"), 0, "no bout from a late callback");
        assert_eq!(count_events(&res, "forged"), 0, "no fighter stored from a late callback");
    }
    assert_eq!(w.challenge_view(id).await?["status"], "Refunded", "terminal status is not overwritten");
    assert!(w.view("get_fighter_by_sentence", json!({"sentence": s})).await?.is_null());
    assert_eq!(w.stats().await?["bouts"], 0);
    Ok(())
}

#[tokio::test]
async fn on_forged_is_private_and_unknown_or_foreign_callbacks_cannot_be_forced() -> Result<()> {
    let (w, _belt, _) = belt_with_bob().await?;
    for id in [1u64, 2, 999] {
        let r = w.call(&w.bob, "on_forged", json!({"challenge_id": id}), 0).await?;
        assert!(r.is_failure(), "on_forged({id}) by a stranger must fail");
        assert!(failure_text(&r).to_lowercase().contains("private"), "{}", failure_text(&r));
    }
    // self-call with no promise result (no OutLayer answer exists): must not mint a fight or move money
    let before = w.bal(&w.bob).await?;
    let r = w.ts.as_account().call(w.ts.id(), "on_forged").args_json(json!({"challenge_id": 999})).transact().await?;
    let _ = r; // either a failure (no promise result) or a soft no-op: both are fine, state must not change
    assert_eq!(w.bal(&w.bob).await?, before);
    assert_eq!(w.stats().await?["bouts"], 0);
    Ok(())
}

#[tokio::test]
async fn relayer_mode_forge_nobody_answers_expires_with_refund_minus_fee() -> Result<()> {
    let w = World::with(Opts { forge_mode: "relayer", ..Opts::default() }).await?;
    w.add_relayer().await?;
    w.deposit(&w.bob, NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (c_s, _) = archetype("raccoon running a casino");
    let belt = w.create_belt().await?;
    w.open_season_relayer(belt, &o_s, &o_raw, 3600, 10u128.pow(16)).await?;
    let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    let r = w.ok(&w.bob, "challenge", json!({"belt_id": belt, "sentence": c_s}), 0).await?;
    let id = r.clone().json::<u64>()?;
    assert!(event(&r, "forge_requested").is_some(), "relayer mode logs forge_requested for the worker");
    assert_eq!(w.last_request().await?, 0, "relayer mode never calls OutLayer");
    w.advance_secs(605).await?;
    w.ok(&w.carol, "expire_challenge", json!({"id": id}), 0).await?;
    let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    titleshot_it::snap::assert_refund_minus_fee_relayer(&before, &after, w.opts.forge_fee, &w.bob);
    assert_clean_refund(&w, id, &c_s, &w.bob).await?;
    // and a relayer answer after expiry is refused (not Forging any more)
    let (_, raw) = archetype("raccoon running a casino");
    let late = w.submit_forge(&w.relayer, id, &w.ai.good(&c_s, &raw, &vrf_from(5))).await?;
    assert_code(&late, "E_NOT_FORGING", "late relayer answer");
    Ok(())
}

#[tokio::test]
async fn platform_limit_yield_resume_payload_over_1024_bytes_is_refused_by_nearcore() -> Result<()> {
    // FINDING (documented as a test): a promise yielded with promise_yield_create can only be resumed with <= 1024
    // payload bytes. A real NEAR AI forge output is ~2.5-3.5 KB, so if outlayer.testnet delivers results through the
    // raw yield payload the callback would never see a compile. outlayer-mock's default `resolve` side-steps the limit
    // (stores the output, resumes with a handle); `resolve_direct` reproduces the limit exactly.
    let (w, belt, (s, raw)) = belt_with_bob().await?;
    let (_st, req, id) = w.start_challenge(&w.bob, belt, &s).await?;
    let big = w.ai.good(&s, &raw, &vrf_from(1)).to_string();
    assert!(big.len() > 1024, "a compile output is {} bytes", big.len());
    let r = w.ol.call("resolve_direct").args_json(json!({"request_id": req, "output_json": big})).transact().await?;
    assert!(r.is_failure() && failure_text(&r).contains("1024"), "expected nearcore's 1024-byte yield payload limit: {}", failure_text(&r));
    let small = w.ai.vrf_only(&vrf_from(1)).to_string();
    assert!(small.len() < 1024);
    let ok = w.ol.call("resolve_direct").args_json(json!({"request_id": req, "output_json": small})).transact().await?;
    assert!(ok.is_success(), "a payload under 1 KB resumes fine: {}", failure_text(&ok));
    let _ = id;
    Ok(())
}
