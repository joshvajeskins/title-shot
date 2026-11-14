//! The request bytes are bound to real recorded NEAR AI calls (`vectors/nearai-real-*.json`): the provider_tee signature
//! covers sha256(request), so a single byte of drift here would make every on-chain verification fail.
use bout_sim::rulebook::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const GLM: &str = "z-ai/glm-5.3-flash";

fn recording(name: &str) -> Value {
    let p = format!("{}/../../vectors/nearai-real-z_ai_glm_5_3_flash-{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn glm_request_hash_equals_the_signed_low_reasoning_recordings() {
    for name in ["pigeon-low", "cactus-low"] {
        let v = recording(name);
        assert_eq!(v["model"], GLM);
        let body = build_request(GLM, v["sentence"].as_str().unwrap());
        assert_eq!(hex(&Sha256::digest(&body)), v["request_sha256"].as_str().unwrap(), "{name}: request hash");
        assert_eq!(body, v["request_utf8"].as_str().unwrap().as_bytes(), "{name}: request bytes");
        // the signed text binds the same request hash
        let text = v["signature"]["text"].as_str().unwrap();
        assert!(text.starts_with(&format!("{GLM}:{}:", hex(&Sha256::digest(&body)))), "{name}: signed text");
    }
}

#[test]
fn the_low_reasoning_recordings_carry_a_fighter_that_normalizes_cleanly() {
    for name in ["pigeon-low", "cactus-low"] {
        let v = recording(name);
        let resp: Value = serde_json::from_str(v["response_utf8"].as_str().unwrap()).unwrap();
        assert_eq!(resp["choices"][0]["finish_reason"], "stop", "{name}");
        let content = resp["choices"][0]["message"]["content"].as_str().unwrap();
        let spec = bout_sim::normalize_str(content).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(!spec.name.is_empty(), "{name}");
    }
}

#[test]
fn the_plain_glm_recording_no_longer_matches_the_request() {
    // Recorded without a reasoning control; it ran out of tokens. The current request differs only by that control.
    let v = recording("pigeon");
    let body = build_request(GLM, v["sentence"].as_str().unwrap());
    assert_ne!(hex(&Sha256::digest(&body)), v["request_sha256"].as_str().unwrap());
    let plain = String::from_utf8(body).unwrap().replacen("\"reasoning_effort\":\"low\",", "", 1);
    assert_eq!(plain, v["request_utf8"].as_str().unwrap());
}

#[test]
fn reasoning_control_sits_immediately_before_temperature_per_model() {
    let cases = [
        (GLM, "\"reasoning_effort\":\"low\","),
        ("z-ai/glm-5.3", "\"reasoning_effort\":\"low\","),
        ("Qwen/Qwen3.8-27B", "\"chat_template_kwargs\":{\"enable_thinking\":false},"),
        ("Qwen/Qwen3-VL-30B-A3B-Instruct", "\"chat_template_kwargs\":{\"enable_thinking\":false},"),
        ("deepseek-ai/DeepSeek-V3.1", ""),
        ("z-ai/glm-4.6", ""),
        ("qwen/qwen3", ""),
    ];
    for (model, ctl) in cases {
        assert_eq!(reasoning_control(model), ctl, "{model}");
        let (_, s) = request_parts(model);
        let s = String::from_utf8(s).unwrap();
        assert!(s.contains(&format!("}}}},{ctl}\"temperature\":0,")), "{model}: {s}");
        let body = build_request(model, "a cactus that gives hugs");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["temperature"], 0);
        match ctl {
            "" => assert!(v.get("reasoning_effort").is_none() && v.get("chat_template_kwargs").is_none()),
            c if c.contains("reasoning") => assert_eq!(v["reasoning_effort"], "low"),
            _ => assert_eq!(v["chat_template_kwargs"]["enable_thinking"], false),
        }
    }
}

#[test]
fn the_reasoning_control_leaves_the_prompt_and_rulebook_hash_alone() {
    // pinned: the prompt, schema and version are unchanged by the request-level reasoning control
    assert_eq!(hex(&rulebook_hash()), "61ec96b27661f09562445f749400ce92c546e01f22e95885d240422f464fae1c");
    let other = "deepseek-ai/DeepSeek-V3.1";
    let strip = |m: &str| String::from_utf8(request_parts(m).0).unwrap().replacen(&serde_json::to_string(m).unwrap(), "", 1);
    assert_eq!(strip(GLM), strip(other), "prefix differs only by the model id");
    let (_, s_glm) = request_parts(GLM);
    let (_, s_other) = request_parts(other);
    assert_eq!(String::from_utf8(s_glm).unwrap().replacen(reasoning_control(GLM), "", 1), String::from_utf8(s_other).unwrap());
}
