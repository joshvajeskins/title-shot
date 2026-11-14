#![allow(unused_must_use)]
//! Test 22: OutLayer large outputs. nearcore refuses `promise_yield_resume` payloads over 1024 bytes, and a real forge
//! output is 2-4 KB. The real OutLayer contract keeps such an output in its own state (`submit_execution_output_and_resolve`),
//! resumes the yield with metadata only, and its callback `on_execution_response` hands the stored JSON bytes to the
//! caller with `env::value_return` (github.com/out-layer/outlayer contract/src/execution.rs:393, 1073, 702). The caller's
//! `on_forged` therefore receives the whole output as an ordinary promise result. outlayer-mock reproduces that path.
use anyhow::Result;
use serde_json::json;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, vrf_from};
use titleshot_it::util::*;
use titleshot_it::world::{Run, World};

async fn setup() -> Result<(World, u32)> {
    let w = World::new().await?;
    w.deposit(&w.bob, 2 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let belt = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?.belt;
    Ok((w, belt))
}

#[tokio::test]
async fn a_3kb_forge_output_travels_the_stored_output_path_and_the_callback_resolves_the_bout() -> Result<()> {
    let (w, belt) = setup().await?;
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let out = w.ai.good_padded(&x_s, &x_raw, &vrf_from(3), 2_300);
    let size = out.to_string().len();
    assert!((3_000..4_000).contains(&size), "a realistic forge output: {size} bytes");
    let (st, req, id) = w.start_challenge(&w.bob, belt, &x_s).await?;
    // The platform limit, on the real mock: the same bytes inside the resume payload are refused by nearcore.
    let direct = w.ol.call("resolve_direct").args_json(json!({"request_id": req, "output_json": out.to_string()})).transact().await?;
    assert!(direct.is_failure() && failure_text(&direct).contains("1024"), "{}", failure_text(&direct));
    // The worker's way (execution.rs:393): output stored in OutLayer state, the yield resumed with metadata only.
    assert!(w.answer(req, &out).await?);
    let res = w.finish(st, id).await?;
    let r = w.request(req).await?;
    assert_eq!(r["output_path"], "stored", "the output did not ride in the yield payload: {r}");
    assert!(r["resume_bytes"].as_u64().unwrap() < 1024, "resume payload is metadata only: {r}");
    assert!(r["output"].as_str().unwrap().len() > 3_000, "OutLayer returned the whole output to the caller");
    let ch = w.challenge_view(id).await?;
    assert_eq!(ch["status"], "Resolved", "{ch}");
    assert!(ch["need_compile"] == true && !w.view("get_fighter_by_sentence", json!({"sentence": x_s})).await?.is_null(), "the compile in the 3 KB output was verified and stored");
    let run = Run { id, req, input: w.request_input(req).await?, res };
    println!("GAS large_output_3kb: tx total {:.1} Tgas, on_forged {:.1} Tgas, output {size} B, resume payload {} B",
        tgas(run.res.total_gas_burnt), run.callback_gas("ts.test.near"), r["resume_bytes"]);
    Ok(())
}

#[tokio::test]
async fn a_small_output_rides_inline_and_an_oversized_one_is_refunded_with_a_stable_code() -> Result<()> {
    let (w, belt) = setup().await?;
    // The cached-fighter case: a VRF-only output is well under 1024 bytes and goes inline (execution.rs:434).
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let (st, req, id) = w.start_challenge(&w.bob, belt, &x_s).await?;
    assert!(w.answer(req, &w.ai.good(&x_s, &x_raw, &vrf_from(4))).await?);
    w.finish(st, id).await?;
    let (c_s, _) = archetype("pigeon with a law degree");
    let small = w.ai.vrf_only(&vrf_from(5));
    assert!(small.to_string().len() < 700);
    // (a different sentence needs a compile, so use the cached one for the inline case: challenge it again as carol)
    w.deposit(&w.carol, NEAR).await?;
    let (st, req, id) = w.start_challenge(&w.carol, belt, &x_s).await?;
    assert!(w.answer(req, &small).await?);
    w.finish(st, id).await?;
    let r = w.request(req).await?;
    assert_eq!(r["output_path"], "inline", "{r}");
    assert_eq!(w.challenge_view(id).await?["status"], "Resolved");
    // 20 KB of output: the contract's own cap (16 KB) refuses it softly, the toll comes back minus the fee.
    let before = w.bal(&w.bob).await?;
    let big = {
        let mut o = w.ai.vrf_only(&vrf_from(6));
        o["info"] = json!("x".repeat(20_000));
        o
    };
    let (st, req, id) = w.start_challenge(&w.bob, belt, &c_s).await?;
    assert!(w.answer(req, &big).await?);
    w.finish(st, id).await?;
    let ch = w.challenge_view(id).await?;
    assert!(ch["status"] == "Refunded" && ch["code"] == "E_FORGE_OUTPUT", "{ch}");
    assert!(u(&ch["storage_charge"]) > 0, "the failed challenge pays its storage");
    assert_eq!(w.bal(&w.bob).await?, before - w.opts.forge_fee - u(&ch["storage_charge"]), "toll minus fee and storage back");
    Ok(())
}
