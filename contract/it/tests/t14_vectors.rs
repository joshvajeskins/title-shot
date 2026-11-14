#![allow(unused_must_use)]
//! Independent vectors through the game contract. `vectors/synthetic-eip191-1.json` was produced by the ecrecover
//! spike (k256 signer, checked by node/noble and by the spike contract); any `vectors/nearai-*.json` recorded from
//! the real NEAR AI Cloud is replayed the same way (none exists yet: the key was never available).
//! The vector's fighter JSON is not a bout-sim fighter, so a signature that verifies ends `Rejected` with a
//! *sim* code, never `E_AI_SIG`: that is how this test tells "signature accepted" from "signature refused".
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bout_sim::types::Winner;
use serde_json::{json, Value};
use std::path::PathBuf;
use titleshot_it::flows::Arena;
use titleshot_it::simx::archetype;
use titleshot_it::util::*;
use titleshot_it::world::{Opts, World};

fn vector_files() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors");
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            n.ends_with(".json") && (n.starts_with("synthetic-") || n.starts_with("nearai-"))
        })
        .collect();
    v.sort();
    v
}

/// The contract refuses sentences it cannot hash into a request (control characters, length): those cases cannot
/// reach the signature check through `challenge`.
fn reachable(sentence: &str) -> bool {
    let n = sentence.chars().count();
    (3..=120).contains(&n) && !sentence.chars().any(|c| c.is_control()) && sentence.trim() == sentence
}

#[tokio::test]
async fn recorded_signature_vectors_are_accepted_or_refused_exactly_as_the_spike_expected() -> Result<()> {
    let files = vector_files();
    assert!(!files.is_empty(), "no vectors found in vectors/");
    for f in files {
        let vec: Value = serde_json::from_str(&std::fs::read_to_string(&f)?)?;
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        if vec.get("cases").is_none() || vec.get("prefix_b64").is_none() {
            // A single recorded compile (`nearai-real-*`), not a spike case table: replayed by t24_review_fixes.
            println!("VECTOR {name}: single recording, replayed by t24");
            continue;
        }
        let w = World::with(Opts { delay_sec: 0, ..Opts::default() }).await?;
        w.deposit(&w.bob, 20 * NEAR).await?;
        let (o_s, o_raw) = archetype("hedgehog in samurai armor");
        let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
        w.ok(&w.owner, "propose_allowlist", json!({"addrs": vec["allowlist"]}), 1).await?;
        w.advance_secs(2).await?;
        w.ok(&w.owner, "apply_allowlist", json!({}), 0).await?;
        let mut ran = 0;
        for kind in ["provider_tee", "gateway"] {
            w.ok(
                &w.owner,
                "set_request",
                json!({"model_id": vec["model_id"], "req_prefix": vec["prefix_b64"], "req_suffix": vec["suffix_b64"], "signature_kind": kind}),
                1,
            )
            .await?;
            let cfg = w.view("get_config", json!({})).await?;
            assert_eq!(cfg["signature_kind"], kind);
            assert_eq!(cfg["prefix_len"], B64.decode(vec["prefix_b64"].as_str().unwrap())?.len());
            for case in vec["cases"].as_array().unwrap() {
                let cname = case["name"].as_str().unwrap();
                if case["signature_kind"] != kind || case["signature_kind"] == "tee" || !reachable(case["sentence"].as_str().unwrap()) {
                    continue;
                }
                let sentence = case["sentence"].as_str().unwrap().to_string();
                let out = json!({"ok": true, "response": case["response"], "signature": case["signature_hex"], "signing_algo": case["signing_algo"],
                    "signature_kind": case["signature_kind"], "vrf": {"output_hex": hex::encode([9u8; 32])}});
                let run = w.run_challenge(&w.bob, arena.belt, &sentence, |_| out.clone()).await?;
                let ch = w.challenge_view(run.id).await?;
                let (status, code) = (ch["status"].as_str().unwrap_or(""), ch["code"].as_str().unwrap_or(""));
                assert!(status == "Rejected" || status == "Refunded", "{name}/{cname}: nothing in a vector can win a fight: {ch}");
                if case["expect"]["ok"] == true {
                    assert!(code != "E_AI_SIG" && !code.starts_with("E_FORGE"), "{name}/{cname}: a valid signature was refused ({code}): {ch}");
                } else {
                    assert!(code.starts_with("E_"), "{name}/{cname}: {ch}");
                    let envelope_family = ["signed_not_json", "signed_empty_choices", "signed_null_content", "signed_empty_content"];
                    if !envelope_family.contains(&cname) {
                        assert!(
                            code == "E_AI_SIG" || code == "E_RESPONSE_SIZE" || code == "E_FORGE_OUTPUT",
                            "{name}/{cname}: spike expected {} (signature refused), contract says {code}",
                            case["expect"]["code"]
                        );
                    }
                }
                assert!(w.view("get_fighter_by_sentence", json!({"sentence": sentence})).await?.is_null(), "{name}/{cname}: nothing stored");
                ran += 1;
                println!("VECTOR {name:30} {kind:12} {cname:44} -> {status}/{code}");
            }
        }
        assert!(ran >= 10, "{name}: only {ran} vector cases were reachable");
    }
    Ok(())
}

#[tokio::test]
async fn tricky_sentences_quotes_backslash_emoji_unicode_and_markup_sign_and_verify_end_to_end() -> Result<()> {
    // The contract rebuilds `prefix ++ json_escape(sentence) ++ suffix` itself; the honest signer here signs the bytes
    // bout_sim::rulebook::build_request produces. Any escaping disagreement shows up as E_AI_SIG.
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol] {
        w.deposit(a, 4 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let sentences = [
        "she said \"no\" and left",
        "back\\slash\\\\duo",
        "a boxer \u{1F94A} with a grudge",
        "\u{65E5}\u{672C}\u{8A9E} hedgehog with \u{00E9}clair",
        "<script>alert(1)</script> & friends",
        "line\u{2028}separator and \u{2029}paragraph",
        "tab-free but 100% \u{201C}smart\u{201D} quotes",
        "x\u{7F}del",
    ];
    let champs = ["raccoon running a casino", "cat who has already knocked", "mime trapped", "disco ball", "dragon who only collects socks", "grumpy mountain", "lighthouse", "very polite kraken"];
    let who = [&w.bob, &w.carol, &w.alice];
    let mut done = 0;
    for (i, s) in sentences.iter().enumerate() {
        let (_, raw) = archetype(champs[i]);
        if bout_sim::spec::check_sentence(s).is_err() {
            // the shared sentence rule (control / bidi characters) refuses it up front: the contract must too
            let r = w.call(who[i % 3], "challenge", json!({"belt_id": arena.belt, "sentence": s}), 0).await?;
            assert_code(&r, "E_SENTENCE", &format!("sentence {s:?} that bout_sim::check_sentence refuses"));
            continue;
        }
        let cleaned = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned == *s {
            let b = arena.fight(who[i % 3], (s, &raw), Winner::Champion).await?;
            b.assert_as_asked();
        } else {
            // Unicode whitespace (U+2028/2029) is collapsed to one space BEFORE hashing and before the AI request is
            // built: the compile is signed for the cleaned sentence while the contract is sent the raw one.
            let (champ, chall, rule, ai) = (arena.champ.clone(), titleshot_it::simx::spec(&raw), arena.rule, w.ai.clone());
            let (c2, r2) = (cleaned.clone(), raw.clone());
            let run = w
                .run_challenge(who[i % 3], arena.belt, s, move |id| ai.good(&c2, &r2, &titleshot_it::simx::find_vrf(&champ, &chall, id, rule, Winner::Champion)))
                .await?;
            let ch = w.challenge_view(run.id).await?;
            assert_eq!(ch["sentence"], cleaned, "stored sentence is the cleaned one");
            assert_eq!(ch["status"], "Resolved", "compile signed for the cleaned sentence must verify: {ch}");
        }
        assert!(!w.view("get_fighter_by_sentence", json!({"sentence": s})).await?.is_null(), "stored: {s:?}");
        done += 1;
    }
    assert!(done >= 5, "at least the quote/backslash/emoji/CJK/markup sentences must run end to end, ran {done}");
    // whitespace is cleaned before hashing AND before the request is built
    let (c_s, c_raw) = archetype("lighthouse");
    let messy = format!("  {}  ", c_s.replace(' ', "   "));
    let run = w
        .run_challenge(&w.alice, arena.belt, &messy, |_| w.ai.good(&c_s, &c_raw, &titleshot_it::simx::vrf_from(808)))
        .await;
    let run = run?;
    let ch = w.challenge_view(run.id).await?;
    assert_eq!(ch["sentence"], c_s, "stored sentence is the cleaned one");
    assert_eq!(ch["status"], "Resolved", "a compile signed for the cleaned sentence verifies: {ch}");
    Ok(())
}
