use bout_sim::rulebook::*;
use sha2::{Digest, Sha256};
fn h(b: &[u8]) -> String { hex(&Sha256::digest(b)) }
fn main() {
    let model = "Qwen/Qwen3.8-27B";
    let (p, s) = request_parts(model);
    let sentences = ["a pigeon with a law degree", "she said \"no\" and left", "back\\slash and /slash", "ctrl \u{1} \u{1f} chars", "emoji 🥊 and 🏆 日本語 éè", "tab\there\nnewline", "<script>alert(1)</script> & 'quotes'", "line sep \u{2028} para \u{2029} del \u{7f}"];
    let cases: Vec<_> = sentences.iter().map(|x| { let r = build_request(model, x); serde_json::json!({"sentence": x, "request_sha256": h(&r), "request_len": r.len(), "escaped": json_escape(x)}) }).collect();
    let out = serde_json::json!({"model": model, "prefix_sha256": h(&p), "suffix_sha256": h(&s), "prefix_len": p.len(), "suffix_len": s.len(), "rulebook_hash": hex(&rulebook_hash()), "cases": cases});
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
