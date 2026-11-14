//! The forge sends exactly the bytes NEAR AI signed: replays the real glm-5.3-flash recordings
//! (`vectors/nearai-real-z_ai_glm_5_3_flash-*-low.json`) through `compile` with an offline transport.
use crate::compile::*;
use crate::input::Failure;
use crate::output::sha256_hex;
use serde_json::Value;
use std::cell::Cell;

fn recording(name: &str) -> Value {
    let p = format!("{}/../vectors/nearai-real-z_ai_glm_5_3_flash-{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

struct Replay {
    v: Value,
    posted: Cell<bool>,
}

impl Http for Replay {
    fn post_json(&self, path: &str, _key: &str, body: &[u8]) -> Result<Resp, Failure> {
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(sha256_hex(body), self.v["request_sha256"].as_str().unwrap(), "request hash = the signed one");
        assert_eq!(body, self.v["request_utf8"].as_str().unwrap().as_bytes(), "request bytes = the recorded ones");
        self.posted.set(true);
        Ok(Resp { status: 200, body: self.v["response_utf8"].as_str().unwrap().as_bytes().to_vec() })
    }
    fn get(&self, _q: &str, _key: &str) -> Result<Resp, Failure> {
        Ok(Resp { status: 200, body: self.v["signature"].to_string().into_bytes() })
    }
    fn sleep_ms(&self, _ms: u64) {}
    fn elapsed_ms(&self) -> u64 {
        0
    }
}

#[test]
fn forge_posts_the_exact_signed_bytes_for_the_real_glm_recordings_and_accepts_their_signed_text() {
    for name in ["pigeon-low", "cactus-low"] {
        let v = recording(name);
        let m = Replay { v: v.clone(), posted: Cell::new(false) };
        let s = compile(&m, "k", v["model"].as_str().unwrap(), v["sentence"].as_str().unwrap()).unwrap_or_else(|e| panic!("{name}: {}", e.code));
        assert!(m.posted.get());
        assert_eq!(s.text, v["signature"]["text"].as_str().unwrap(), "{name}: signed text self-check passed");
        assert_eq!(s.response, v["response_utf8"].as_str().unwrap(), "{name}: response bytes kept exact");
        assert_eq!(s.signature_kind, "provider_tee");
    }
}

#[test]
fn the_plain_recording_is_not_what_the_forge_sends_any_more() {
    let v = recording("pigeon");
    let body = crate::request::build_body(v["model"].as_str().unwrap(), v["sentence"].as_str().unwrap());
    assert_ne!(sha256_hex(&body), v["request_sha256"].as_str().unwrap());
    assert!(String::from_utf8(body).unwrap().contains("},\"reasoning_effort\":\"low\",\"temperature\":0,"));
}
