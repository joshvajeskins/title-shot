#![allow(unused_must_use)]
//! Opus review fixes, on the real wasm:
//! 1. `set_request` / `set_forge_mode` are timelocked like the allowlist (staged, published, `apply_config` after the delay).
//! 2. Real NEAR AI recordings (`vectors/nearai-real-*.json`, z-ai/glm-5.3-flash, provider_tee) go through `submit_forge`:
//!    the plain recording's request is rebuilt byte for byte by `bout_sim::rulebook`, so its real TEE signature verifies on
//!    chain; that recording stopped at the token limit (`finish_reason: "length"`, `content: null`, reasoning only), so the
//!    verified envelope is then rejected `E_NO_CONTENT` (never `E_AI_SIG`). The `-low` recordings added
//!    `"reasoning_effort":"low"` to the request body, which the contract does not send, so they must fail the signature
//!    check (`E_AI_SIG`): request drift is caught, never accepted.
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
async fn real_near_ai_recordings_verify_on_chain_and_request_drift_is_refused() -> Result<()> {
    let w = World::with(Opts { forge_mode: "relayer", delay_sec: 0, ..Opts::default() }).await?;
    w.add_relayer().await?;
    let real = recording("pigeon");
    let model = real["model"].as_str().unwrap();
    let sentence = real["sentence"].as_str().unwrap();
    assert_eq!(real["request_utf8"].as_str().unwrap().as_bytes(), bout_sim::rulebook::build_request(model, sentence).as_slice(), "request rebuilt byte for byte");
    let (p, s) = bout_sim::rulebook::request_parts(model);
    w.ok(&w.owner, "set_request", json!({"model_id": model, "req_prefix": B64.encode(p), "req_suffix": B64.encode(s), "signature_kind": "provider_tee"}), 1).await?;
    w.ok(&w.owner, "propose_allowlist", json!({"addrs": [real["recovered"]]}), 1).await?;
    w.ok(&w.bob, "apply_allowlist", json!({}), 0).await?;
    let belt = w.create_belt().await?;
    // Each recording is offered as the opener; a refused one aborts the season and the promoter opens again.
    for (name, code) in [("cactus-low", "E_AI_SIG"), ("pigeon-low", "E_AI_SIG"), ("pigeon", "E_NO_CONTENT")] {
        let v = recording(name);
        let r = w.ok(&w.promoter, "open_season", json!({"belt_id": belt, "opener_sentence": v["sentence"], "duration_sec": 3600, "purse_wei": U(0)}), w.opts.forge_fee).await?;
        let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested"))?["challenge_id"].as_u64().unwrap();
        let sig = &v["signature"];
        let out = json!({"ok": true, "response": v["response_utf8"], "signature": sig["signature"], "signing_algo": sig["signing_algo"],
                         "signature_kind": sig["signature_kind"]});
        let sub = w.submit_forge(&w.relayer, id, &out).await?;
        assert!(sub.is_success(), "{name}: {}", failure_text(&sub));
        let c = w.challenge_view(id).await?;
        assert!(c["status"] == "Rejected" && c["code"] == code, "{name}: want {code}: {c}");
        assert!(w.view("get_fighter_by_sentence", json!({"sentence": v["sentence"]})).await?.is_null(), "{name}: nothing stored");
        if code == "E_NO_CONTENT" {
            // The signature stage passed: the contract's own rebuilt request hashed to the bytes NEAR AI signed.
            let resp: Value = serde_json::from_str(v["response_utf8"].as_str().unwrap())?;
            assert_eq!(resp["choices"][0]["finish_reason"], "length", "the recording ran out of tokens before any content");
            println!("REAL VECTOR {name}: TEE signature verified on chain; envelope has no content (token limit)");
        }
    }
    Ok(())
}
