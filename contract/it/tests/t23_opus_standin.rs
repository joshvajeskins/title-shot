#![allow(unused_must_use)]
//! Opus review: the staging stand-in compiler (web/functions/_lib/standin.ts) signs
//! `standin/compiler-v1:{sha256(req)}:{sha256(resp)}` (EIP-191, test key) and the relayer tick (tick.ts `relay`) sends
//! that as `output_json`. Vectors come from the web code itself: `cd web && npx tsx ../contract/it/standin/gen.ts`.
//! The contract, configured the way a staging deploy is (model `standin/compiler-v1`, request parts from
//! `bout_sim::rulebook::request_parts`, the stand-in address as the only signer, relayer mode), must accept them for an
//! opener and for paid challenges, including a sentence the contract cleans (collapsed spaces) before it rebuilds the request.
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use titleshot_it::util::*;
use titleshot_it::world::{Opts, World, U};

fn vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/standin/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("run standin/gen.ts first")).unwrap()
}

#[tokio::test]
async fn the_contract_accepts_the_web_standin_compiler_envelope_for_openers_and_challenges() -> Result<()> {
    let v = vectors();
    let model = v["model"].as_str().unwrap();
    assert_eq!(model, "standin/compiler-v1");
    let vs = v["vectors"].as_array().unwrap();
    // The web's request bytes are exactly what the contract rebuilds (prefix ++ serde escape ++ suffix).
    for x in vs {
        let s = x["sentence"].as_str().unwrap();
        assert_eq!(x["request"].as_str().unwrap().as_bytes(), bout_sim::rulebook::build_request(model, s).as_slice(), "{s}");
        assert_eq!(x["verified_by_web"]["verified"], true);
    }
    let w = World::with(Opts { forge_mode: "relayer", delay_sec: 0, ..Opts::default() }).await?;
    w.add_relayer().await?;
    let (p, s) = bout_sim::rulebook::request_parts(model);
    w.ok(&w.owner, "set_request", json!({"model_id": model, "req_prefix": B64.encode(p), "req_suffix": B64.encode(s), "signature_kind": "provider_tee"}), 1).await?;
    w.ok(&w.owner, "propose_allowlist", json!({"addrs": [v["signer"]]}), 1).await?;
    w.ok(&w.bob, "apply_allowlist", json!({}), 0).await?;
    let belt = w.create_belt().await?;

    // Opener: a roster sentence, compiled by the stand-in.
    let r = w.ok(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": vs[0]["sentence"], "duration_sec": 3600, "purse_wei": U(0)}), w.opts.forge_fee).await?;
    let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?["challenge_id"].as_u64().unwrap();
    let sub = w.submit_forge(&w.relayer, id, &serde_json::from_str(vs[0]["output_json"].as_str().unwrap())?).await?;
    assert!(sub.is_success(), "{}", failure_text(&sub));
    let c = w.challenge_view(id).await?;
    assert_eq!(c["status"], "Resolved", "stand-in opener must verify: {c}");
    let f = w.view("get_fighter_by_sentence", json!({"sentence": vs[0]["sentence"]})).await?;
    assert_eq!(f["signer"].as_str().unwrap().to_lowercase(), v["signer"].as_str().unwrap().to_lowercase(), "{f}");

    // Paid challenges: escapes/unicode, and a sentence sent with runs of spaces that the contract collapses.
    let sent = [(&w.alice, vs[1]["sentence"].as_str().unwrap().to_string()), (&w.bob, "the toaster that remembers   every   slice".to_string())];
    for (i, (who, sentence)) in sent.iter().enumerate() {
        w.deposit(who, NEAR).await?;
        let r = w.ok(who, "challenge", json!({"belt_id": belt, "sentence": sentence}), 0).await?;
        let ev = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?;
        assert_eq!(ev["sentence"], vs[i + 1]["sentence"], "the relayer compiles the contract's cleaned sentence");
        let id = ev["challenge_id"].as_u64().unwrap();
        let out: Value = serde_json::from_str(vs[i + 1]["output_json"].as_str().unwrap())?;
        let sub = w.submit_forge(&w.relayer, id, &out).await?;
        assert!(sub.is_success(), "{}", failure_text(&sub));
        let c = w.challenge_view(id).await?;
        assert!(c["status"] == "Resolved" && !c["fight_id"].is_null(), "stand-in compile must verify and fight: {c}");
    }
    Ok(())
}
