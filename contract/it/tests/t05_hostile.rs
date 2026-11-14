#![allow(unused_must_use)]
//! Test 5: hostile forge outputs. Every one must end Rejected/Refunded with toll minus fee returned, no fight,
//! no stored fighter, no lock; and none of them may poison the sentence for an honest compile afterwards.
use anyhow::Result;
use serde_json::{json, Value};
use titleshot_it::fixtures::Hostile;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, vrf_from};
use titleshot_it::snap::{assert_refund_minus_fee, snap};
use titleshot_it::util::*;
use titleshot_it::world::World;

struct Case {
    name: &'static str,
    out: Value,
    /// Acceptable stable codes in the challenge's status.
    codes: Vec<&'static str>,
}

fn case(name: &'static str, out: Value, codes: &[&'static str]) -> Case {
    Case { name, out, codes: codes.to_vec() }
}

#[tokio::test]
async fn every_hostile_forge_output_is_rejected_with_a_refund_and_never_becomes_a_fighter() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, 5 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let belt = arena.belt;
    let (s, raw) = archetype("raccoon running a casino");
    let (other_s, _) = archetype("grumpy mountain");
    let ai = &w.ai;
    let vrf = vrf_from(4242);
    let bad = |m: fn(&mut Value)| Hostile::signed_bad_fighter(ai, &s, &raw, &vrf, m);
    let mut ed = ai.good(&s, &raw, &vrf);
    ed["signing_algo"] = json!("ed25519");
    let mut no_ai = ai.good(&s, &raw, &vrf);
    no_ai.as_object_mut().unwrap().remove("response");
    no_ai.as_object_mut().unwrap().remove("signature");
    let mut short_sig = ai.good(&s, &raw, &vrf);
    short_sig["signature"] = json!(&short_sig["signature"].as_str().unwrap()[..100]);
    let mut empty_sig = ai.good(&s, &raw, &vrf);
    empty_sig["signature"] = json!("");
    let cases = vec![
        case("tampered response byte after signing", Hostile::tampered_response(ai, &s, &raw, &vrf), &["E_AI_SIG"]),
        case("valid signature by a key that is not allowlisted", Hostile::unlisted_signer(ai, &s, &raw, &vrf), &["E_AI_SIG"]),
        case("signature replayed from another sentence", Hostile::replayed_for_other_sentence(ai, &other_s, &raw, &vrf), &["E_AI_SIG"]),
        case("signed the other signature kind's text", Hostile::wrong_kind_text(ai, &s, &raw, &vrf), &["E_AI_SIG"]),
        case("signing_algo ed25519", ed, &["E_AI_SIG"]),
        case("truncated signature", short_sig, &["E_AI_SIG"]),
        case("empty signature", empty_sig, &["E_AI_SIG"]),
        case("response over the 8 KB cap (validly signed)", Hostile::over_length(ai, &s, &vrf), &["E_AI_SIG", "E_RESPONSE_SIZE", "E_FORGE_OUTPUT"]),
        case("signed refusal verdict", bad(|r| r["verdict"] = json!("refused")), &["E_REFUSED"]),
        case("signed unknown move id", bad(|r| r["moves"][0]["id"] = json!("not_a_move")), &["E_UNKNOWN_MOVE"]),
        case("signed duplicate moves", bad(|r| r["moves"][1]["id"] = r["moves"][0]["id"].clone()), &["E_DUP_MOVE"]),
        case("signed unknown school", bad(|r| r["school"] = json!("PLASMA")), &["E_BAD_SCHOOL"]),
        case("signed empty fighter name", bad(|r| r["name"] = json!("   ")), &["E_EMPTY_FIELD"]),
        case("signed non-JSON content", Hostile::signed_garbage_content(ai, &s, &vrf), &["E_BAD_JSON"]),
        case("compile missing although the contract asked for one", no_ai, &["E_AI_SIG", "E_FORGE_OUTPUT", "E_NO_COMPILE", "E_FORGE_FAILED"]),
    ];
    for c in cases {
        let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
        let run = w.run_challenge(&w.bob, belt, &s, |_| c.out.clone()).await?;
        let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
        let ch = w.challenge_view(run.id).await?;
        let status = ch["status"].as_str().unwrap_or("");
        assert!(status == "Rejected" || status == "Refunded", "{}: status {ch}", c.name);
        let code = ch["code"].as_str().unwrap_or("");
        assert!(c.codes.contains(&code), "{}: code {code} not in {:?} ({ch})", c.name, c.codes);
        assert_refund_minus_fee(&before, &after, w.opts.toll, w.opts.forge_fee, &w.bob);
        assert!(ch["fight_id"].is_null(), "{}: no fight", c.name);
        assert!(w.view("get_fighter_by_sentence", json!({"sentence": s})).await?.is_null(), "{}: nothing stored", c.name);
        assert!(w.view("get_pending", json!({"account": w.bob.id()})).await?.is_null(), "{}: lock cleared", c.name);
        assert_eq!(count_events(&run.res, "bout"), 0, "{}: no bout", c.name);
        println!("HOSTILE ok: {:<55} -> {status}/{code}", c.name);
    }
    let belt_v = w.view("get_belt", json!({"id": belt})).await?;
    assert_eq!(belt_v["season"]["pending"], 0);
    assert_eq!(belt_v["holder"], w.promoter.id().to_string());
    assert_eq!(w.stats().await?["bouts"], 0);
    // none of the above poisoned the sentence: an honest compile of the same sentence now resolves
    let run = w.run_challenge(&w.bob, belt, &s, |_| ai.good(&s, &raw, &vrf_from(4243))).await?;
    let ch = w.challenge_view(run.id).await?;
    assert_eq!(ch["status"], "Resolved", "{ch}");
    assert!(!w.view("get_fighter_by_sentence", json!({"sentence": s})).await?.is_null(), "honest compile stored");
    Ok(())
}

#[tokio::test]
async fn gateway_kind_deployment_accepts_gateway_signatures_and_rejects_provider_tee_text() -> Result<()> {
    use titleshot_it::world::Opts;
    let w = World::with(Opts { kind: "gateway", ..Opts::default() }).await?;
    w.deposit(&w.bob, 2 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let (s, raw) = archetype("raccoon running a casino");
    let vrf = vrf_from(99);
    // the honest signer signs the provider_tee text while the contract expects gateway text -> rejected
    let mut tee = w.ai.clone();
    tee.kind = "provider_tee".into();
    let wrong = tee.good(&s, &raw, &vrf);
    let run = w.run_challenge(&w.bob, arena.belt, &s, |_| wrong.clone()).await?;
    let ch = w.challenge_view(run.id).await?;
    assert!(ch["status"] == "Rejected" || ch["status"] == "Refunded", "{ch}");
    assert_eq!(ch["code"], "E_AI_SIG");
    // gateway text accepted
    let run = w.run_challenge(&w.bob, arena.belt, &s, |_| w.ai.good(&s, &raw, &vrf)).await?;
    assert_eq!(w.challenge_view(run.id).await?["status"], "Resolved");
    Ok(())
}
