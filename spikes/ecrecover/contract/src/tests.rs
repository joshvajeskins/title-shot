//! Native unit tests (mocked blockchain; real host-function semantics for sha256/keccak/ecrecover).
use crate::verify::{self, code};
use crate::Contract;
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, Value};

const SYNTH: &str = include_str!("../../../../vectors/synthetic-eip191-1.json");

fn v() -> Value {
    serde_json::from_str(SYNTH).expect("vector json")
}
fn s(x: &Value, k: &str) -> String {
    x[k].as_str().unwrap_or_else(|| panic!("missing {k}")).to_string()
}
fn b64(x: &str) -> Vec<u8> {
    let b: Base64VecU8 = serde_json::from_str(&format!("\"{x}\"")).unwrap();
    b.0
}

fn contract(vec: &Value) -> Contract {
    let allow: Vec<String> = vec["allowlist"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().into()).collect();
    Contract::new(allow, Base64VecU8(b64(&s(vec, "prefix_b64"))), Base64VecU8(b64(&s(vec, "suffix_b64"))), s(vec, "model_id"))
}

/// Every case of the committed synthetic vector (valid + negatives) against the native contract.
#[test]
fn synthetic_vector_cases() {
    let vec = v();
    let c = contract(&vec);
    let cases = vec["cases"].as_array().unwrap();
    assert!(cases.len() >= 12, "expected a full case table, got {}", cases.len());
    for case in cases {
        let out = c.verify_forge(
            s(case, "sentence"),
            s(case, "response"),
            s(case, "signature_hex"),
            s(case, "signing_algo"),
            s(case, "signature_kind"),
        );
        let want = &case["expect"];
        assert_eq!(out.code, s(want, "code"), "case {}", s(case, "name"));
        assert_eq!(out.ok, want["ok"].as_bool().unwrap(), "case {}", s(case, "name"));
        if out.ok {
            assert_eq!(out.content.as_deref(), want["content"].as_str(), "case {}", s(case, "name"));
        }
    }
}

#[test]
fn escape_matches_node_json_stringify() {
    for case in v()["escape_cases"].as_array().unwrap() {
        let input = s(case, "input");
        assert_eq!(verify::json_escape(&input), s(case, "escaped"), "escape of {:?}", input);
    }
}

#[test]
fn sig_decoding() {
    assert_eq!(verify::decode_sig("zz").unwrap_err(), code::SIG_HEX);
    assert_eq!(verify::decode_sig(&"00".repeat(64)).unwrap_err(), code::SIG_LEN);
    assert_eq!(verify::decode_sig(&"00".repeat(66)).unwrap_err(), code::SIG_LEN);
    let mk = |last: &str| format!("{}{last}", "11".repeat(64));
    assert_eq!(verify::decode_sig(&mk("1b")).unwrap().1, 0);
    assert_eq!(verify::decode_sig(&mk("1c")).unwrap().1, 1);
    assert_eq!(verify::decode_sig(&mk("00")).unwrap().1, 0);
    assert_eq!(verify::decode_sig(&format!("0x{}", mk("01"))).unwrap().1, 1);
    assert_eq!(verify::decode_sig(&mk("02")).unwrap_err(), code::SIG_V);
    assert_eq!(verify::decode_sig(&mk("1d")).unwrap_err(), code::SIG_V);
}

#[test]
fn init_rejects_bad_config() {
    let ok = |a: Vec<String>, p: &[u8], s: &[u8], m: &str| {
        let (p, s, m) = (p.to_vec(), s.to_vec(), m.to_string());
        std::panic::catch_unwind(move || Contract::new(a, Base64VecU8(p), Base64VecU8(s), m)).is_ok()
    };
    let addr = "0x835ab53d20294ef795906dff21ae4c045336aa26".to_string();
    assert!(ok(vec![addr.clone()], b"p", b"s", "m"));
    assert!(!ok(vec![], b"p", b"s", "m"));
    assert!(!ok(vec!["0x1234".into()], b"p", b"s", "m"));
    assert!(!ok(vec![addr.clone()], b"", b"s", "m"));
    assert!(!ok(vec![addr], b"p", b"s", ""));
}
