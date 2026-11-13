//! Generates vectors/synthetic-eip191-1.json: a NEAR-AI-shaped request/response signed EIP-191 with
//! a throwaway secp256k1 key (random per run, never written to disk), plus every negative case as a
//! pre-built table row. Only the vector is committed, never a key.
//! usage: cargo run --bin gen_vectors -- <vectors dir>
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::ops::Neg;
use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

const MODEL: &str = "Qwen/Qwen3.8-27B";

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}
fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}
fn eip191(text: &str) -> [u8; 32] {
    let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    m.extend_from_slice(text.as_bytes());
    keccak(&m)
}
fn address(k: &SigningKey) -> String {
    let pt = k.verifying_key().to_encoded_point(false);
    format!("0x{}", hex::encode(&keccak(&pt.as_bytes()[1..])[12..]))
}
/// r||s||v with v in {27,28} (what eth_account / ethers emit).
fn sign(k: &SigningKey, text: &str) -> Vec<u8> {
    let (sig, rec) = k.sign_prehash_recoverable(&eip191(text)).expect("sign");
    let mut o = sig.to_bytes().to_vec();
    o.push(27 + rec.to_byte());
    o
}
fn escape(s: &str) -> String {
    let q = serde_json::to_string(s).unwrap();
    q[1..q.len() - 1].to_string()
}

/// Placeholder rulebook-sized request template (~6 KB system prompt) so gas is realistic.
fn parts() -> (String, String) {
    let rules = "RULE: moves are distinct and drawn from the library; stats follow weights under a 100-point budget; names are original, no real people, no slurs. ";
    let system = format!("Compile the player's sentence into a fighter JSON under rulebook v1. {}", rules.repeat(40));
    let schema = json!({"type":"object","additionalProperties":false,
        "required":["name","title","look","cry","school","style","moves","weights"],
        "properties":{"name":{"type":"string","maxLength":24},"title":{"type":"string","maxLength":40},
        "look":{"type":"string","maxLength":160},"cry":{"type":"string","maxLength":60},
        "school":{"type":"string","enum":["EMBER","TIDE","STONE","GALE","VOLT","SHADE"]},
        "style":{"type":"string","enum":["BRAWLER","TACTICIAN","COUNTERPUNCHER","SHOWBOAT"]},
        "moves":{"type":"array","items":{"type":"string"},"minItems":3,"maxItems":3},
        "weights":{"type":"object","additionalProperties":false,"required":["power","guard","speed","grit"],
        "properties":{"power":{"type":"integer"},"guard":{"type":"integer"},"speed":{"type":"integer"},"grit":{"type":"integer"}}}}});
    let head = json!({"model":MODEL,"stream":false,"temperature":0,"max_tokens":600,
        "response_format":{"type":"json_schema","json_schema":{"name":"fighter","strict":true,"schema":schema}},
        "messages":[{"role":"system","content":system},{"role":"user","content":"@@SENTENCE@@"}]});
    let s = serde_json::to_string(&head).unwrap();
    let (p, q) = s.split_once("@@SENTENCE@@").unwrap();
    (p.to_string(), q.to_string())
}

fn envelope(content: Value) -> String {
    serde_json::to_string(&json!({"id":"chatcmpl-synth-0001","object":"chat.completion","created":1794500000,
        "model":MODEL,"choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":1500,"completion_tokens":120,"total_tokens":1620}}))
    .unwrap()
}

fn main() {
    let dir = std::env::args().nth(1).expect("vectors dir");
    let key = SigningKey::random(&mut rand_core::OsRng);
    let other = SigningKey::random(&mut rand_core::OsRng);
    let (prefix, suffix) = parts();
    let req = |sent: &str| format!("{prefix}{}{suffix}", escape(sent));
    let tee_text = |sent: &str, resp: &str, model: &str| {
        format!("{model}:{}:{}", sha_hex(req(sent).as_bytes()), sha_hex(resp.as_bytes()))
    };
    let gw_text = |sent: &str, resp: &str| format!("{}:{}", sha_hex(req(sent).as_bytes()), sha_hex(resp.as_bytes()));

    let sentence = "I fight like a cornered badger with a grudge and a very good lawyer";
    let fighter = r#"{"name":"Grudge Badger","title":"The Cornered","look":"Scarred badger in a pinstripe vest","cry":"Objection!","school":"STONE","style":"COUNTERPUNCHER","moves":["m_stone_wall","m_iron_jab","m_counter_roll"],"weights":{"power":4,"guard":7,"speed":3,"grit":6}}"#;
    let resp = envelope(json!(fighter));
    let ok_sig = sign(&key, &tee_text(sentence, &resp, MODEL));
    let h = |b: &[u8]| hex::encode(b);
    let with_v = |sig: &[u8], v: u8| {
        let mut s = sig.to_vec();
        s[64] = v;
        h(&s)
    };
    let mk = |name: &str, sent: &str, response: &str, sig: String, kind: &str, algo: &str, code: &str, content: Option<&str>| {
        json!({"name":name,"sentence":sent,"response":response,"signature_hex":sig,"signing_algo":algo,
               "signature_kind":kind,"expect":{"ok":code=="OK","code":code,"content":content}})
    };
    let tee = "provider_tee";
    let mut cases: Vec<Value> = vec![];
    cases.push(mk("valid_provider_tee_v27_28", sentence, &resp, h(&ok_sig), tee, "ecdsa", "OK", Some(fighter)));
    cases.push(mk("valid_v_0_1", sentence, &resp, with_v(&ok_sig, ok_sig[64] - 27), tee, "ecdsa", "OK", Some(fighter)));
    cases.push(mk("valid_0x_prefix_uppercase", sentence, &resp, format!("0x{}", h(&ok_sig).to_uppercase()), tee, "ecdsa", "OK", Some(fighter)));
    let gw_sig = sign(&key, &gw_text(sentence, &resp));
    cases.push(mk("valid_gateway_kind", sentence, &resp, h(&gw_sig), "gateway", "ecdsa", "OK", Some(fighter)));
    let uni = "She said \"no\" \\ then\tleft \u{1F94A} 日本語\nline two";
    let uni_sig = sign(&key, &tee_text(uni, &resp, MODEL));
    cases.push(mk("valid_unicode_escaped_sentence", uni, &resp, h(&uni_sig), tee, "ecdsa", "OK", Some(fighter)));

    let tampered_resp = resp.replace("Grudge Badger", "Grudge Badgar");
    cases.push(mk("tampered_response_byte", sentence, &tampered_resp, h(&ok_sig), tee, "ecdsa", "E_SIGNER", None));
    cases.push(mk("tampered_response_trailing_newline", sentence, &format!("{resp}\n"), h(&ok_sig), tee, "ecdsa", "E_SIGNER", None));
    cases.push(mk("tampered_sentence", &format!("{sentence}!"), &resp, h(&ok_sig), tee, "ecdsa", "E_SIGNER", None));
    let other_model_sig = sign(&key, &tee_text(sentence, &resp, "other/model-9"));
    cases.push(mk("signed_with_different_model_id", sentence, &resp, h(&other_model_sig), tee, "ecdsa", "E_SIGNER", None));
    let stranger_sig = sign(&other, &tee_text(sentence, &resp, MODEL));
    cases.push(mk("signer_not_in_allowlist", sentence, &resp, h(&stranger_sig), tee, "ecdsa", "E_SIGNER", None));
    cases.push(mk("gateway_sig_submitted_as_provider_tee", sentence, &resp, h(&gw_sig), tee, "ecdsa", "E_SIGNER", None));
    cases.push(mk("provider_tee_sig_submitted_as_gateway", sentence, &resp, h(&ok_sig), "gateway", "ecdsa", "E_SIGNER", None));

    // high-s twin of a valid signature: s' = n - s, recovery id flipped. Must be rejected.
    let mut hs = ok_sig.clone();
    let s_scalar = Scalar::from_repr(*k256::FieldBytes::from_slice(&ok_sig[32..64])).unwrap();
    hs[32..64].copy_from_slice(&s_scalar.neg().to_bytes());
    hs[64] = if ok_sig[64] == 27 { 28 } else { 27 };
    cases.push(mk("high_s_malleable_twin", sentence, &resp, h(&hs), tee, "ecdsa", "E_RECOVER", None));
    cases.push(mk("zero_r_s_signature", sentence, &resp, h(&[vec![0u8; 64], vec![27]].concat()), tee, "ecdsa", "E_RECOVER", None));
    cases.push(mk("truncated_sig_64_bytes", sentence, &resp, h(&ok_sig[..64]), tee, "ecdsa", "E_SIG_LEN", None));
    cases.push(mk("overlong_sig_66_bytes", sentence, &resp, format!("{}00", h(&ok_sig)), tee, "ecdsa", "E_SIG_LEN", None));
    cases.push(mk("bad_recovery_byte_2", sentence, &resp, with_v(&ok_sig, 2), tee, "ecdsa", "E_SIG_V", None));
    cases.push(mk("bad_recovery_byte_29", sentence, &resp, with_v(&ok_sig, 29), tee, "ecdsa", "E_SIG_V", None));
    cases.push(mk("non_hex_signature", sentence, &resp, "not-hex-at-all".into(), tee, "ecdsa", "E_SIG_HEX", None));
    cases.push(mk("algo_ed25519_unsupported", sentence, &resp, h(&ok_sig), tee, "ed25519", "E_ALGO", None));
    cases.push(mk("kind_unknown", sentence, &resp, h(&ok_sig), "tee", "ecdsa", "E_KIND", None));
    cases.push(mk("sentence_over_1024_bytes", &"a".repeat(1025), &resp, h(&ok_sig), tee, "ecdsa", "E_SENTENCE_SIZE", None));

    // signed but oversized (cap enforced before any crypto): 9000-byte content
    let big = envelope(json!("x".repeat(9000)));
    let big_sig = sign(&key, &tee_text(sentence, &big, MODEL));
    cases.push(mk("oversized_response_9k_validly_signed", sentence, &big, h(&big_sig), tee, "ecdsa", "E_RESPONSE_SIZE", None));
    // validly signed, but not a usable envelope
    for (name, body, code) in [
        ("signed_not_json", "this is not json".to_string(), "E_ENVELOPE"),
        ("signed_empty_choices", serde_json::to_string(&json!({"choices":[]})).unwrap(), "E_ENVELOPE"),
        ("signed_null_content", envelope(Value::Null), "E_NO_CONTENT"),
        ("signed_empty_content", envelope(json!("")), "E_NO_CONTENT"),
    ] {
        let sg = sign(&key, &tee_text(sentence, &body, MODEL));
        cases.push(mk(name, sentence, &body, h(&sg), tee, "ecdsa", code, None));
    }

    let escape_cases: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/escape-cases.json")).expect("run scripts/gen-escape-cases.mjs first")).unwrap();
    let out = json!({
        "kind": "synthetic",
        "note": "EIP-191 signatures by a throwaway key (not stored). Expectations are derived, then checked by native unit tests, node (noble) and the wasm in the sandbox.",
        "model_id": MODEL,
        "allowlist": [address(&key)],
        "unlisted_signer": address(&other),
        "prefix_b64": B64.encode(&prefix),
        "suffix_b64": B64.encode(&suffix),
        "request_bytes_for_base_case": req(sentence).len(),
        "escape_cases": escape_cases,
        "cases": cases,
    });
    let path = format!("{dir}/synthetic-eip191-1.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    println!("wrote {path}: {} cases, signer {}, prefix {} B, suffix {} B", cases.len(), address(&key), prefix.len(), suffix.len());
}
