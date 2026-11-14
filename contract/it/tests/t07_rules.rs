#![allow(unused_must_use)]
//! Tests 7, 8, 9, 10: canonical fighters, refusals before money moves, one pending challenge, sealed rule.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::json;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, find_vrf, sentence_hash, spec, vrf_from};
use titleshot_it::util::*;
use titleshot_it::world::World;

async fn funded() -> Result<World> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol] {
        w.deposit(a, 2 * NEAR).await?;
    }
    Ok(w)
}

#[tokio::test]
async fn second_challenge_with_the_same_sentence_reuses_the_canonical_fighter_and_requests_no_compile() -> Result<()> {
    let w = funded().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    // bob: first paid forge of the sentence (compile requested)
    let b1 = arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?;
    assert!(b1.compiled);
    assert_eq!(b1.run.input["need_compile"], true, "first forge asks OutLayer for a compile: {}", b1.run.input);
    let first = w.view("get_fighter_by_sentence", json!({"sentence": x_s})).await?;
    assert_eq!(first["writer"], w.bob.id().to_string());
    assert_eq!(first["hash"], sentence_hash(&x_s));
    // carol: same sentence -> reuses the stored fighter, only a fresh VRF seed is requested
    let b2 = arena.fight(&w.carol, (&x_s, &x_raw), Winner::Champion).await?;
    assert!(!b2.compiled);
    assert_eq!(b2.run.input["need_compile"], false, "no compile for a known sentence: {}", b2.run.input);
    assert_eq!(b2.run.input["sentence"], x_s);
    assert_eq!(b2.run.res.is_success(), true);
    let bout_id = w.challenge_view(b2.run.id).await?;
    assert_eq!(bout_id["status"], "Resolved", "{bout_id}");
    assert_ne!(b1.fight["seed"], b2.fight["seed"], "a fresh seed per paid challenge");
    assert_eq!(b2.fight["challenger_hash"], b1.fight["challenger_hash"], "same fighter");
    // alice: same sentence again, but this time the (honest-signed) output carries a DIFFERENT compile -> ignored
    let (_, other_raw) = archetype("cat who has already knocked");
    let champ = spec(&o_raw);
    let chall = spec(&x_raw);
    let ai = w.ai.clone();
    let (xs, orw) = (x_s.clone(), other_raw.clone());
    let rule = arena.rule;
    let run = w
        .run_challenge(&w.alice, arena.belt, &x_s, move |id| ai.good(&xs, &orw, &find_vrf(&champ, &chall, id, rule, Winner::Champion)))
        .await?;
    let ch = w.challenge_view(run.id).await?;
    assert_eq!(ch["status"], "Resolved", "{ch}");
    let after = w.view("get_fighter_by_sentence", json!({"sentence": x_s})).await?;
    assert_eq!(after["spec"], first["spec"], "the first paid forge of a sentence is final; a later compile is ignored");
    assert_eq!(after["writer"], first["writer"]);
    let fight = w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
    assert_eq!(fight["winner"], "champion", "the bout used the stored spec (the stored fighter loses to this champion)");
    assert_eq!(after["record"]["losses"], 3, "one fighter record across all three bouts");
    Ok(())
}

#[tokio::test]
async fn self_challenge_champion_sentence_and_bad_sentences_are_refused_before_any_money_moves() -> Result<()> {
    let w = funded().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    w.deposit(&w.promoter, NEAR).await?;
    let (x_s, _) = archetype("raccoon running a casino");
    let belt = arena.belt;
    let (p0, b0) = (w.bal(&w.promoter).await?, w.bal(&w.bob).await?);
    let refused = |r: near_workspaces::result::ExecutionFinalResult, code: &str, ctx: &str| assert_code(&r, code, ctx);
    refused(w.call(&w.promoter, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?, "E_SELF", "the belt holder challenging own belt");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": o_s}), 0).await?, "E_SAME_SENTENCE", "champion's own sentence");
    let spaced = format!("   {}  ", o_s.replace(' ', "   "));
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": spaced}), 0).await?, "E_SAME_SENTENCE", "champion's sentence with extra whitespace (cleaned first)");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": "ab"}), 0).await?, "E_SENTENCE", "2 characters");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": "   a   "}), 0).await?, "E_SENTENCE", "1 character after trimming");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": "x".repeat(121)}), 0).await?, "E_SENTENCE", "121 characters");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": "a goose\u{0007} with a bell"}), 0).await?, "E_SENTENCE", "control character");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": "a boxer\u{202E}reversed text"}), 0).await?, "E_SENTENCE", "bidi override character");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": "zero\u{200B}width space"}), 0).await?, "E_SENTENCE", "invisible character");
    refused(w.call(&w.bob, "challenge", json!({"belt_id": 99, "sentence": x_s}), 0).await?, "E_NO_BELT", "unknown belt");
    let broke = w.call(&w.relayer, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?;
    refused(broke, "E_BALANCE", "no balance at all");
    // exactly toll - 1 yocto is still not enough
    let toll = w.opts.toll;
    w.ok(&w.owner, "deposit", json!({}), ACCOUNT_STORAGE + toll - 1).await?;
    refused(w.call(&w.owner, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?, "E_BALANCE", "balance one yocto short of the toll");
    assert_eq!((w.bal(&w.promoter).await?, w.bal(&w.bob).await?), (p0, b0), "no balance moved on any refusal");
    assert_eq!(u(&w.stats().await?["tolls"]), 0, "no toll collected");
    assert_eq!(w.last_request().await?, 1, "OutLayer was only asked for the opener");
    Ok(())
}

#[tokio::test]
async fn challenging_a_belt_without_a_season_or_while_the_opener_is_forging_is_refused() -> Result<()> {
    let w = funded().await?;
    let belt = w.create_belt().await?;
    let (x_s, _) = archetype("raccoon running a casino");
    let r = w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?;
    assert_code(&r, "E_NO_SEASON", "belt with no season yet");
    // season opened but the opener is still being forged: no champion to fight
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let prev = w.last_request().await?;
    let st = w
        .promoter
        .call(w.ts.id(), "open_season")
        .args_json(json!({"belt_id":belt,"opener_sentence":o_s,"duration_sec":3600,"purse_wei":"1000"}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(w.opts.forge_fee))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact_async()
        .await?;
    let req = w.wait_request(prev).await?;
    let r = w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?;
    assert_code(&r, "E_NO_CHAMPION", "challenge while the opener is forging");
    w.answer(req, &w.ai.good(&o_s, &o_raw, &vrf_from(1))).await?;
    let id = w.request_input(req).await?["challenge_id"].as_u64().unwrap();
    w.finish(st, id).await?;
    assert_eq!(w.view("get_belt", json!({"id": belt})).await?["season"]["state"], "Open");
    // and after the bell no challenge is accepted either
    Ok(())
}

#[tokio::test]
async fn one_pending_challenge_per_account_across_belts_and_cleared_when_it_ends() -> Result<()> {
    let w = funded().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (o2_s, o2_raw) = archetype("grumpy mountain");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let (y_s, _) = archetype("cat who has already knocked");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let belt2 = w.create_belt().await?;
    w.open_season(belt2, &o2_s, &o2_raw, 3600, 10u128.pow(16)).await?;
    let (st, req, id) = w.start_challenge(&w.bob, arena.belt, &x_s).await?;
    let pending = w.view("get_pending", json!({"account": w.bob.id()})).await?;
    assert_eq!(pending["id"], id);
    assert_eq!(pending["status"], "Forging");
    let bal = w.bal(&w.bob).await?;
    for (belt, sentence) in [(arena.belt, &y_s), (arena.belt, &x_s), (belt2, &y_s)] {
        let r = w.call(&w.bob, "challenge", json!({"belt_id": belt, "sentence": sentence}), 0).await?;
        assert_code(&r, "E_PENDING", &format!("second challenge on belt {belt} while one is forging"));
    }
    assert_eq!(w.bal(&w.bob).await?, bal, "the refused attempts cost nothing");
    // other accounts are not blocked by bob's lock
    let (st_c, req_c, id_c) = w.start_challenge(&w.carol, belt2, &x_s).await?;
    // finish both: bob's lock clears
    w.answer(req, &w.ai.good(&x_s, &x_raw, &vrf_from(11))).await?;
    w.finish(st, id).await?;
    w.answer(req_c, &w.ai.vrf_only(&vrf_from(12))).await?;
    w.finish(st_c, id_c).await?;
    assert!(w.view("get_pending", json!({"account": w.bob.id()})).await?.is_null());
    let (_st3, _req3, id3) = w.start_challenge(&w.bob, belt2, &y_s).await?;
    assert!(id3 > id_c, "bob can challenge again once the first one ended");
    Ok(())
}

#[tokio::test]
async fn sealed_rule_is_revealed_exactly_once_at_the_first_bout_and_stays_fixed_for_the_season() -> Result<()> {
    let w = funded().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let (y_s, y_raw) = archetype("cat who has already knocked");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let season = w.season(arena.belt).await?;
    assert_eq!(season["sealed"], true);
    assert!(season["rule"].is_null(), "no rule before the first bout: {season}");
    let b1 = arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?;
    let (rule, n1) = (b1.rule, count_events(&b1.run.res, "rule_revealed"));
    let ev = event(&b1.run.res, "rule_revealed").expect("rule_revealed event at the first bout");
    assert_eq!(ev["rule"], rule);
    assert_eq!(n1, 1);
    assert!(rule < 8);
    let season = w.season(arena.belt).await?;
    assert_eq!(season["sealed"], false);
    assert_eq!(season["rule"], rule, "rule = seed[0] % 8 of the first bout");
    let seed1 = hex::decode(b1.fight["seed"].as_str().unwrap())?;
    assert_eq!(rule, seed1[0] % 8, "the revealed rule is derived from the first bout's seed");
    let b2 = arena.fight(&w.carol, (&y_s, &y_raw), Winner::Champion).await?;
    assert_eq!(count_events(&b2.run.res, "rule_revealed"), 0, "never revealed twice");
    assert_eq!(b2.fight["rule"], rule, "same rule for every bout of the season");
    let season = w.season(arena.belt).await?;
    assert_eq!(season["bouts"], 2);
    Ok(())
}
