#![allow(unused_must_use)]
//! Opus review fixes, on the real wasm:
//! 1. `set_request` / `set_forge_mode` are timelocked like the allowlist (staged, published, `apply_config` after the delay).
//! 2. Real NEAR AI recordings (`vectors/nearai-real-*.json`, z-ai/glm-5.3-flash, provider_tee) go through `submit_forge`
//!    on a contract configured with the glm request parts (`bout_sim::rulebook::request_parts`, which now carries
//!    `"reasoning_effort":"low"` for glm-5.3). The `-low` recordings' requests are rebuilt byte for byte, so their real TEE
//!    signatures verify on chain and both fighters are ACCEPTED (one opens the season, the other challenges it). The plain
//!    recording was sent without the reasoning control (and ran out of tokens): its request no longer matches what the
//!    contract sends, so it fails the signature check (`E_AI_SIG`): request drift is caught, never accepted.
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use titleshot_it::util::*;
use titleshot_it::world::{Opts, World, U};

fn recording(name: &str) -> Value {
    let p = format!("{}/../../vectors/nearai-real-z_ai_glm_5_3_flash-{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[tokio::test]
async fn request_and_forge_mode_changes_are_staged_published_and_applied_only_after_the_timelock() -> Result<()> {
    let w = World::new().await?; // allowlist_delay_sec = 120
    let model0 = w.view("get_config", json!({})).await?["model_id"].clone();
    let (p, s) = bout_sim::rulebook::request_parts("other/model");
    let args = json!({"model_id": "other/model", "req_prefix": B64.encode(&p), "req_suffix": B64.encode(&s), "signature_kind": "gateway"});
    assert_code(&w.call(&w.bob, "set_request", args.clone(), 1).await?, "E_NOT_OWNER", "non-owner request change");
    w.ok(&w.owner, "set_request", args, 1).await?;
    w.ok(&w.owner, "set_forge_mode", json!({"mode": "relayer"}), 1).await?;
    let cfg = w.view("get_config", json!({})).await?;
    assert_eq!(cfg["model_id"], model0, "nothing applies before the timelock");
    assert_eq!(cfg["forge_mode"], "outlayer");
    assert_eq!(cfg["pending_config"]["request"]["model_id"], "other/model");
    assert_eq!(cfg["pending_config"]["request"]["prefix_sha256"], hex::encode(Sha256::digest(&p)));
    assert_eq!(cfg["pending_config"]["forge_mode"], "relayer");
    assert_code(&w.call(&w.bob, "apply_config", json!({}), 0).await?, "E_TIMELOCK", "early apply");
    w.advance_secs(121).await?;
    w.ok(&w.bob, "apply_config", json!({}), 0).await?;
    let cfg = w.view("get_config", json!({})).await?;
    assert_eq!(cfg["model_id"], "other/model");
    assert_eq!(cfg["signature_kind"], "gateway");
    assert_eq!(cfg["forge_mode"], "relayer");
    assert!(cfg["pending_config"].is_null());
    Ok(())
}

#[tokio::test]
async fn real_near_ai_low_reasoning_recordings_are_accepted_on_chain_and_request_drift_is_refused() -> Result<()> {
    let w = World::with(Opts { forge_mode: "relayer", delay_sec: 0, ..Opts::default() }).await?;
    w.add_relayer().await?;
    let real = recording("pigeon-low");
    let model = real["model"].as_str().unwrap();
    assert_eq!(model, "z-ai/glm-5.3-flash");
    for name in ["pigeon-low", "cactus-low"] {
        let v = recording(name);
        let body = bout_sim::rulebook::build_request(model, v["sentence"].as_str().unwrap());
        assert_eq!(v["request_utf8"].as_str().unwrap().as_bytes(), body.as_slice(), "{name}: request rebuilt byte for byte");
        assert_eq!(hex::encode(Sha256::digest(&body)), v["request_sha256"].as_str().unwrap(), "{name}: request hash");
    }
    let plain = recording("pigeon");
    assert_ne!(plain["request_utf8"].as_str().unwrap().as_bytes(), bout_sim::rulebook::build_request(model, plain["sentence"].as_str().unwrap()).as_slice());
    let (p, s) = bout_sim::rulebook::request_parts(model);
    w.ok(&w.owner, "set_request", json!({"model_id": model, "req_prefix": B64.encode(p), "req_suffix": B64.encode(s), "signature_kind": "provider_tee"}), 1).await?;
    w.ok(&w.owner, "propose_allowlist", json!({"addrs": [real["recovered"]]}), 1).await?;
    w.ok(&w.bob, "apply_allowlist", json!({}), 0).await?;
    let belt = w.create_belt().await?;
    let out_of = |v: &Value| {
        let sig = &v["signature"];
        json!({"ok": true, "response": v["response_utf8"], "signature": sig["signature"], "signing_algo": sig["signing_algo"],
               "signature_kind": sig["signature_kind"]})
    };
    // 1. The plain recording as the opener: its request lacks the reasoning control -> E_AI_SIG, the season aborts.
    let r = w.ok(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": plain["sentence"], "duration_sec": 3600, "purse_wei": U(0)}), w.opts.forge_fee).await?;
    let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?["challenge_id"].as_u64().unwrap();
    let sub = w.submit_forge(&w.relayer, id, &out_of(&plain)).await?;
    assert!(sub.is_success(), "plain: {}", failure_text(&sub));
    let c = w.challenge_view(id).await?;
    assert!(c["status"] == "Rejected" && c["code"] == "E_AI_SIG", "plain: want E_AI_SIG: {c}");
    assert!(w.view("get_fighter_by_sentence", json!({"sentence": plain["sentence"]})).await?.is_null());
    // 2. pigeon-low opens the season: real TEE signature verified on chain, fighter stored, champion set.
    let r = w.ok(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": real["sentence"], "duration_sec": 3600, "purse_wei": U(0)}), w.opts.forge_fee).await?;
    let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?["challenge_id"].as_u64().unwrap();
    let sub = w.submit_forge(&w.relayer, id, &out_of(&real)).await?;
    assert!(sub.is_success(), "pigeon-low: {}", failure_text(&sub));
    let c = w.challenge_view(id).await?;
    assert_eq!(c["status"], "Resolved", "pigeon-low accepted: {c}");
    let f = w.view("get_fighter_by_sentence", json!({"sentence": real["sentence"]})).await?;
    assert_eq!(f["signer"], real["recovered"], "pigeon-low stored with the TEE signer");
    assert_eq!(w.season(belt).await?["state"], "Open");
    assert_eq!(w.view("get_belt", json!({"id": belt})).await?["champion"]["hash"], f["hash"]);
    println!("REAL VECTOR pigeon-low: TEE signature verified on chain; opener {} is champion", f["spec"]["name"]);
    // 3. cactus-low challenges it: accepted, stored, and the bout resolves.
    let cactus = recording("cactus-low");
    w.deposit(&w.bob, NEAR).await?;
    let r = w.ok(&w.bob, "challenge", json!({"belt_id": belt, "sentence": cactus["sentence"]}), 0).await?;
    let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?["challenge_id"].as_u64().unwrap();
    let sub = w.submit_forge(&w.relayer, id, &out_of(&cactus)).await?;
    assert!(sub.is_success(), "cactus-low: {}", failure_text(&sub));
    let c = w.challenge_view(id).await?;
    assert_eq!(c["status"], "Resolved", "cactus-low accepted: {c}");
    assert!(c["fight_id"].is_u64(), "a bout was fought: {c}");
    let f = w.view("get_fighter_by_sentence", json!({"sentence": cactus["sentence"]})).await?;
    assert_eq!(f["signer"], cactus["recovered"]);
    println!("REAL VECTOR cactus-low: TEE signature verified on chain; challenger {} fought fight {}", f["spec"]["name"], c["fight_id"]);
    // Every requested compile was counted, the refused one included.
    assert_eq!(w.view("get_compile_caps", json!({})).await?["used"], 3);
    Ok(())
}
