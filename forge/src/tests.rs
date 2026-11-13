use crate::input::*;
use crate::output::*;
use crate::request::*;

#[test]
fn body_is_prefix_escaped_suffix_and_valid_json() {
    let s = "He said \"hi\"\\ \u{1F525}";
    let body = build_body("m/x", s);
    let (p, suf) = request_parts("m/x");
    assert!(body.starts_with(&p) && body.ends_with(&suf));
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["messages"][1]["content"], format!("Sentence: {s}"));
    assert_eq!(v["model"], "m/x");
    assert_eq!(v["stream"], false);
    assert_eq!(v["response_format"]["type"], "json_schema");
}

#[test]
fn escape_matches_serde_without_quotes() {
    assert_eq!(json_escape("a\"b\nc"), "a\\\"b\\nc");
}

#[test]
fn parses_ops() {
    assert_eq!(parse("{\"op\":\"ping\"}").unwrap(), Input::Ping);
    assert!(matches!(parse("{\"op\":\"forge\",\"challenge_id\":7}").unwrap(), Input::Forge { .. }));
}

#[test]
fn rejects_bad_inputs() {
    assert_eq!(parse("nope").unwrap_err().code, "E_BAD_INPUT");
    assert_eq!(parse("{\"op\":\"zzz\"}").unwrap_err().code, "E_BAD_INPUT");
    let long = "x".repeat(121);
    let j = format!("{{\"op\":\"forge\",\"need_compile\":true,\"sentence\":\"{long}\",\"challenge_id\":1,\"model_id\":\"m\"}}");
    assert_eq!(parse(&j).unwrap_err().code, "E_SENTENCE");
    let j = "{\"op\":\"forge\",\"need_compile\":true,\"sentence\":\"ab\",\"challenge_id\":1,\"model_id\":\"m\"}";
    assert_eq!(parse(j).unwrap_err().code, "E_SENTENCE");
    let j = "{\"op\":\"forge\",\"need_compile\":true,\"sentence\":\"abc\\u0007d\",\"challenge_id\":1,\"model_id\":\"m\"}";
    assert_eq!(parse(j).unwrap_err().code, "E_SENTENCE");
    let j = "{\"op\":\"forge\",\"need_compile\":true,\"sentence\":\"abcd\",\"challenge_id\":1}";
    assert_eq!(parse(j).unwrap_err().code, "E_MODEL_ID");
    assert_eq!(parse("{\"op\":\"probe\",\"path\":\"/v1/chat/completions\"}").unwrap_err().code, "E_PROBE_PATH");
    assert!(parse("{\"op\":\"probe\",\"path\":\"/v1/models\"}").is_ok());
}

#[test]
fn vrf_seed_has_no_colon() {
    assert_eq!(vrf_seed(42), "titleshot-challenge-42");
    assert!(!vrf_seed(u64::MAX).contains(':'));
}

#[test]
fn signed_text_rules() {
    let t = expected_text("provider_tee", "m", b"req", b"resp").unwrap();
    assert!(t.starts_with("m:") && t.matches(':').count() == 2);
    assert_eq!(expected_text("gateway", "m", b"req", b"resp").unwrap().matches(':').count(), 1);
    assert!(expected_text("other", "m", b"", b"").is_none());
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

#[test]
fn compact_output_shape() {
    let vrf = Vrf { output_hex: "a".repeat(64), signature_hex: "b".repeat(128), alpha: "vrf:1:x:s".into() };
    let signed = Signed {
        response: "{\"id\":\"c\"}".into(),
        signature: "0x".to_string() + &"c".repeat(130),
        signing_address: "0x".to_string() + &"d".repeat(40),
        signing_algo: "ecdsa".into(),
        signature_kind: "provider_tee".into(),
        text: "m:h:h".into(),
    };
    let j = ok_json(Some(signed), Some(vrf), None);
    let v: serde_json::Value = serde_json::from_str(&j).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["vrf"]["alpha"], "vrf:1:x:s");
    assert!(v.get("info").is_none());
    let only_vrf = ok_json(None, Some(Vrf { output_hex: "a".into(), signature_hex: "b".into(), alpha: "c".into() }), None);
    assert!(!only_vrf.contains("response"));
}

#[test]
fn fail_json_truncates_detail() {
    let j = fail_json("E_X", &"y".repeat(500));
    let v: serde_json::Value = serde_json::from_str(&j).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["detail"].as_str().unwrap().len(), 200);
}
