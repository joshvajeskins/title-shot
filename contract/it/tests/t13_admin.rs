#![allow(unused_must_use)]
//! Tests 13, 14, 15: signer allowlist timelock, relayer mode, belt NFT transfer.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::{json, Value};
use titleshot_it::expect::split;
use titleshot_it::fixtures::{address, key};
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, find_vrf, seed, spec, vrf_from};
use titleshot_it::snap::{assert_bout_money, snap};

use titleshot_it::util::*;
use titleshot_it::world::{Opts, World};

#[tokio::test]
async fn allowlist_change_is_owner_only_one_yocto_visible_and_applies_only_after_the_timelock() -> Result<()> {
    let w = World::with(Opts { delay_sec: 120, ..Opts::default() }).await?;
    w.deposit(&w.bob, 3 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let old = w.ai.allowlist();
    let new_key = key("rotated-near-ai-signer");
    let new_addr = address(&new_key);
    let cfg = w.view("get_allowlist", json!({})).await?;
    assert_eq!(cfg["active"], json!(old));
    assert!(cfg["pending"].is_null());
    // guards
    assert_code(&w.call(&w.bob, "propose_allowlist", json!({"addrs": [new_addr]}), 1).await?, "E_NOT_OWNER", "non-owner proposing");
    assert!(w.call(&w.owner, "propose_allowlist", json!({"addrs": [new_addr]}), 0).await?.is_failure(), "1 yocto required");
    assert!(w.call(&w.owner, "propose_allowlist", json!({"addrs": ["0x1234"]}), 1).await?.is_failure(), "malformed address refused");
    assert!(w.call(&w.owner, "propose_allowlist", json!({"addrs": []}), 1).await?.is_failure(), "an empty allowlist would brick the game");
    assert!(w.call(&w.bob, "apply_allowlist", json!({}), 0).await?.is_failure(), "nothing pending to apply");
    // propose: visible immediately, not active
    let t0 = w.now_ns().await?;
    w.ok(&w.owner, "propose_allowlist", json!({"addrs": [new_addr]}), 1).await?;
    let cfg = w.view("get_allowlist", json!({})).await?;
    assert_eq!(cfg["active"], json!(old), "the trust point does not change until the timelock ends");
    assert_eq!(cfg["pending"], json!([new_addr]));
    let at = u(&cfg["activates_at"]);
    assert!(at >= t0 as u128 + 120 * 1_000_000_000, "activates at least delay_sec after the proposal");
    assert_code(&w.call(&w.carol, "apply_allowlist", json!({}), 0).await?, "E_TIMELOCK", "apply right away");
    // during the timelock the OLD signer still works and the NEW signer is rejected
    let new_ai = {
        let mut a = w.ai.clone();
        a.signer = new_key.clone();
        a
    };
    let rej = w.run_challenge(&w.bob, arena.belt, &x_s, |_| new_ai.good(&x_s, &x_raw, &vrf_from(1))).await?;
    let ch = w.challenge_view(rej.id).await?;
    assert_eq!(ch["code"], "E_AI_SIG", "a pending signer is not trusted yet: {ch}");
    // after the delay anyone can apply
    w.advance_secs(125).await?;
    w.ok(&w.carol, "apply_allowlist", json!({}), 0).await?;
    let cfg = w.view("get_allowlist", json!({})).await?;
    assert_eq!(cfg["active"], json!([new_addr]));
    assert!(cfg["pending"].is_null());
    assert_code(&w.call(&w.carol, "apply_allowlist", json!({}), 0).await?, "E_", "applying twice");
    // rotated: the new key compiles, the old key no longer does
    let run = w.run_challenge(&w.bob, arena.belt, &x_s, |_| w.ai.good(&x_s, &x_raw, &vrf_from(2))).await?;
    assert_eq!(w.challenge_view(run.id).await?["code"], "E_AI_SIG", "the old signer was rotated out");
    let run = w.run_challenge(&w.bob, arena.belt, &x_s, |_| new_ai.good(&x_s, &x_raw, &vrf_from(3))).await?;
    assert_eq!(w.challenge_view(run.id).await?["status"], "Resolved");
    assert_eq!(w.view("get_fighter_by_sentence", json!({"sentence": x_s})).await?["signer"], new_addr);
    Ok(())
}

#[tokio::test]
async fn relayer_mode_only_listed_relayers_resolve_once_and_the_event_flags_the_block_seed() -> Result<()> {
    let w = World::with(Opts { forge_mode: "relayer", ..Opts::default() }).await?;
    w.deposit(&w.bob, 3 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let belt = w.create_belt().await?;
    // the opener needs the relayer too
    assert_code(&w.submit_forge(&w.relayer, 1, &w.ai.vrf_only(&vrf_from(1))).await?, "E_NOT_RELAYER", "relayer not listed yet");
    w.add_relayer().await?;
    assert!(w.call(&w.bob, "add_relayer", json!({"acct": w.bob.id()}), 1).await?.is_failure(), "only the owner lists relayers");
    w.open_season_relayer(belt, &o_s, &o_raw, 3600, 10u128.pow(16)).await?;
    assert_eq!(w.last_request().await?, 0, "OutLayer is never called in relayer mode");
    let (toll, fee) = (w.opts.toll, w.opts.forge_fee);
    let before = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    let r = w.ok(&w.bob, "challenge", json!({"belt_id": belt, "sentence": x_s}), 0).await?;
    let ev = event(&r, "forge_requested").expect("forge_requested event");
    let id = r.clone().json::<u64>()?;
    assert_eq!(ev["challenge_id"], id);
    assert_eq!(ev["sentence"], x_s);
    assert_eq!(ev["need_compile"], true);
    let out = w.ai.good(&x_s, &x_raw, &vrf_from(5));
    // a stranger cannot deliver, even with a perfectly signed output
    assert_code(&w.submit_forge(&w.bob, id, &out).await?, "E_NOT_RELAYER", "the challenger delivering its own forge");
    assert_code(&w.submit_forge(&w.alice, id, &out).await?, "E_NOT_RELAYER", "a stranger");
    assert_eq!(w.challenge_view(id).await?["status"], "Forging", "refused deliveries leave the challenge forging");
    assert_code(&w.submit_forge(&w.relayer, 987, &out).await?, "E_NO_CHALLENGE", "unknown challenge id");
    // the listed relayer resolves it
    let done = w.submit_forge(&w.relayer, id, &out).await?;
    assert!(done.is_success(), "{}", failure_text(&done));
    let ch = w.challenge_view(id).await?;
    assert_eq!(ch["status"], "Resolved", "{ch}");
    let bout = event(&done, "bout").expect("bout event");
    assert_eq!(bout["seed_source"], "block", "relayer-mode seeds are flagged weaker: no VRF");
    let fight = w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
    assert_eq!(fight["seed_source"], "block");
    assert_ne!(fight["seed"], hex::encode(seed(&vrf_from(5), id)), "the relayer's VRF field must not decide a block-seeded bout");
    // the money is the same as in OutLayer mode
    let after = snap(&w, belt, &[&w.bob, &w.promoter]).await?;
    // same split as OutLayer mode; the forge fee is protocol revenue here (nothing is paid to OutLayer)
    let storage = u(&fight["storage"]);
    assert!(storage > 0, "the relayer-mode bout is charged its storage too: {fight}");
    let sp = split(toll, fee + storage);
    let mut exp = before.bal.clone();
    *exp.get_mut(w.bob.id().as_str()).unwrap() -= toll;
    *exp.get_mut(w.promoter.id().as_str()).unwrap() += sp.champion + sp.promoter;
    assert_eq!(after.bal, exp, "balances after a relayer-mode bout, to the yocto");
    assert_eq!(after.side_pot, before.side_pot + sp.side_pot);
    assert_eq!(after.protocol, before.protocol + sp.protocol + fee, "protocol share plus the unspent forge fee");
    assert_eq!(after.fees_spent, before.fees_spent, "no OutLayer deposit is spent in relayer mode");
    // a second delivery for the same challenge is refused
    assert_code(&w.submit_forge(&w.relayer, id, &out).await?, "E_NOT_FORGING", "double delivery");
    assert_eq!(snap(&w, belt, &[&w.bob, &w.promoter]).await?.bal, after.bal, "double delivery moved nothing");
    // a removed relayer can no longer deliver
    w.ok(&w.owner, "remove_relayer", json!({"acct": w.relayer.id()}), 1).await?;
    let r2 = w.ok(&w.carol, "deposit", json!({}), NEAR).await;
    let _ = r2;
    let r3 = w.ok(&w.carol, "challenge", json!({"belt_id": belt, "sentence": "a bold new contender here"}), 0).await?;
    let id3 = r3.json::<u64>()?;
    let late = w.submit_forge(&w.relayer, id3, &w.ai.good("a bold new contender here", &x_raw, &vrf_from(6))).await?;
    assert_code(&late, "E_NOT_RELAYER", "removed relayer");
    Ok(())
}

#[tokio::test]
async fn forge_mode_is_owner_only_and_a_switch_applies_to_new_challenges_only() -> Result<()> {
    // Zero timelock so the switch applies at once (the timelocked path: t24_review_fixes).
    let w = World::with(Opts { delay_sec: 0, ..Opts::default() }).await?;
    w.deposit(&w.bob, 3 * NEAR).await?;
    assert_code(&w.call(&w.bob, "set_forge_mode", json!({"mode": "relayer"}), 1).await?, "E_NOT_OWNER", "non-owner switching mode");
    assert!(w.call(&w.owner, "set_forge_mode", json!({"mode": "relayer"}), 0).await?.is_failure(), "1 yocto required");
    assert!(w.call(&w.owner, "set_forge_mode", json!({"mode": "pigeon"}), 1).await?.is_failure(), "unknown mode refused");
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let (st, req, id) = w.start_challenge(&w.bob, arena.belt, &x_s).await?;
    w.ok(&w.owner, "set_forge_mode", json!({"mode": "relayer"}), 1).await?;
    assert_eq!(w.view("get_config", json!({})).await?["forge_mode"], "relayer");
    // the in-flight OutLayer challenge still resolves through its callback
    let champ = spec(&o_raw);
    let chall = spec(&x_raw);
    w.answer(req, &w.ai.good(&x_s, &x_raw, &find_vrf(&champ, &chall, id, None, Winner::Champion))).await?;
    w.finish(st, id).await?;
    assert_eq!(w.challenge_view(id).await?["status"], "Resolved");
    // a new challenge now waits for a relayer (no OutLayer request)
    let n = w.last_request().await?;
    let r = w.ok(&w.carol, "deposit", json!({}), NEAR).await;
    let _ = r;
    let c = w.ok(&w.carol, "challenge", json!({"belt_id": arena.belt, "sentence": "an unexpected visitor"}), 0).await?;
    assert!(event(&c, "forge_requested").is_some());
    assert_eq!(w.last_request().await?, n);
    Ok(())
}

#[tokio::test]
async fn belt_nft_holder_transfer_makes_the_new_owner_the_champion_who_is_paid_and_cannot_self_challenge() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob, &w.carol, &w.promoter] {
        w.deposit(a, 2 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let (y_s, y_raw) = archetype("cat who has already knocked");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let token = format!("belt-{}", arena.belt);
    // a non-owner cannot move the title
    let r = w.bob.call(w.ts.id(), "nft_transfer").args_json(json!({"receiver_id": w.bob.id(), "token_id": token})).deposit(near_workspaces::types::NearToken::from_yoctonear(1)).transact().await?;
    assert!(r.is_failure(), "only the token owner can transfer: {}", failure_text(&r));
    assert_eq!(w.view("get_belt", json!({"id": arena.belt})).await?["holder"], w.promoter.id().to_string());
    // the holder gifts the title to carol
    let r = w.promoter.call(w.ts.id(), "nft_transfer").args_json(json!({"receiver_id": w.carol.id(), "token_id": token})).deposit(near_workspaces::types::NearToken::from_yoctonear(1)).transact().await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt["holder"], w.carol.id().to_string(), "the NFT owner is the holder");
    // carol is the holder now, so carol cannot challenge; the promoter (no longer the holder) can
    let me = w.call(&w.carol, "challenge", json!({"belt_id": arena.belt, "sentence": x_s}), 0).await?;
    assert_code(&me, "E_SELF", "the new holder challenging own belt");
    // a challenge now pays CAROL the champion share, the promoter keeps only the promoter share
    arena.holder = w.carol.id().to_string();
    let (toll, fee) = (w.opts.toll, w.opts.forge_fee);
    let before = snap(&w, arena.belt, &[&w.bob, &w.carol, &w.promoter]).await?;
    let b = arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?;
    b.assert_as_asked();
    let sp = b.split(toll, fee);
    let after = snap(&w, arena.belt, &[&w.bob, &w.carol, &w.promoter]).await?;
    assert_bout_money(&before, &after, &sp, toll, fee, b.storage(), &w.bob, &w.carol, &w.promoter);
    assert_eq!(after.b(&w.carol), before.b(&w.carol) + sp.champion, "the new holder earns the champion share");
    assert_eq!(after.b(&w.promoter), before.b(&w.promoter) + sp.promoter, "the promoter only the promoter share");
    assert_eq!(b.fight["holder"], w.carol.id().to_string());
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    let dc = belt["season"]["defence_count"].as_array().unwrap();
    assert_eq!(dc.len(), 1);
    assert_eq!(dc[0]["account"], w.carol.id().to_string(), "defence credit follows the NFT holder");
    // the former holder is free to challenge, and can win the belt back
    let b2 = arena.fight(&w.promoter, (&y_s, &y_raw), Winner::Challenger).await;
    if let Err(e) = &b2 {
        panic!("former holder challenge failed: {e}");
    }
    let b2 = b2?;
    b2.assert_as_asked();
    let token_v: Value = w.ts.view("nft_token").args_json(json!({"token_id": token})).await?.json()?;
    assert_eq!(token_v["owner_id"], w.promoter.id().to_string());
    Ok(())
}
