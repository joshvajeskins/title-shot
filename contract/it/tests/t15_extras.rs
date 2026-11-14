#![allow(unused_must_use)]
//! Extras beyond the 15 listed groups, all still against docs/CONTRACT.md: the OutLayer request shape, the pinned VRF
//! proof, concurrent compiles of one sentence, protocol withdrawal, belt creation guards.
use anyhow::Result;
use bout_sim::types::Winner;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use titleshot_it::expect::split;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, find_vrf, seed, spec, vrf_from};
use titleshot_it::util::*;
use titleshot_it::world::{World, U};

#[tokio::test]
async fn outlayer_request_has_the_documented_shape_and_attaches_exactly_the_forge_fee() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, NEAR).await?;
    w.ok(&w.owner, "set_forge_secrets", json!({"profile": "production", "owner": "titleshot.testnet"}), 1).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let opener = w.request(1).await?;
    assert_eq!(opener["caller"], w.ts.id().to_string());
    assert_eq!(u(&opener["deposit"]), w.opts.forge_fee, "the opener forge attaches exactly the belt's forge fee");
    let b = arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?;
    let req = w.request(b.run.req).await?;
    assert_eq!(req["caller"], w.ts.id().to_string());
    assert_eq!(u(&req["deposit"]), w.opts.forge_fee, "deposit == forge_fee: the toll never leaves the ledger");
    let source: Value = serde_json::from_str(req["source"].as_str().unwrap())?;
    assert_eq!(source["Project"]["project_id"], "titleshot.testnet/forge");
    let limits: Value = serde_json::from_str(req["resource_limits"].as_str().unwrap())?;
    assert!(limits.is_object(), "OutLayer runs nothing without resource_limits");
    assert!(limits["max_execution_seconds"].as_u64().unwrap_or(0) <= 180);
    assert_eq!(req["response_format"], "Json");
    let secrets: Value = serde_json::from_str(req["secrets_ref"].as_str().expect("secrets_ref configured"))?;
    assert_eq!(secrets, json!({"profile": "production", "account_id": "titleshot.testnet"}));
    let input: Value = serde_json::from_str(req["input_data"].as_str().unwrap())?;
    assert_eq!(input["op"], "forge");
    assert_eq!(input["sentence"], x_s);
    assert_eq!(input["need_compile"], true);
    assert_eq!(input["challenge_id"], b.run.id);
    assert_eq!(input["model_id"], w.ai.model);
    assert!(req["prepaid_gas"].as_u64().unwrap() >= 100_000_000_000_000, "enough gas for the worker side");
    Ok(())
}

fn vrf_proof(sk: &SigningKey, request_id: u64, sender: &str, challenge_id: u64) -> Value {
    let alpha = format!("vrf:{request_id}:{sender}:titleshot-challenge-{challenge_id}");
    let sig = sk.sign(alpha.as_bytes()).to_bytes();
    json!({"alpha": alpha, "signature_hex": hex::encode(sig), "output_hex": hex::encode(Sha256::digest(sig))})
}

#[tokio::test]
async fn pinned_vrf_key_every_proof_is_verified_wrong_challenge_forged_proof_and_forged_output_are_refunded() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, 3 * NEAR).await?;
    let sk = SigningKey::from_bytes(&Sha256::digest(b"titleshot-it-vrf-key").into());
    w.ok(&w.owner, "set_vrf_pubkey", json!({"pubkey_hex": hex::encode(sk.verifying_key().to_bytes())}), 1).await?;
    assert_eq!(w.view("get_config", json!({})).await?["vrf_pubkey"], hex::encode(sk.verifying_key().to_bytes()));
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    // the opener has no bout, but its output is still parsed: give it a real proof too
    let belt = w.create_belt().await?;
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
    let oid = w.request_input(req).await?["challenge_id"].as_u64().unwrap();
    let mut out = w.ai.good(&o_s, &o_raw, &vrf_from(1));
    out["vrf"] = vrf_proof(&sk, req, w.ts.id().as_str(), oid);
    w.answer(req, &out).await?;
    w.finish(st, oid).await?;
    let champ = spec(&o_raw);
    let chall = spec(&x_raw);
    let ai = w.ai.clone();
    let mut tries: Vec<(&str, Box<dyn Fn(u64, u64) -> Value>)> = vec![];
    {
        let (ai, sk, xs, xr) = (ai.clone(), sk.clone(), x_s.clone(), x_raw.clone());
        tries.push(("proof for another challenge id", Box::new(move |_, id| {
            let mut o = ai.good(&xs, &xr, &vrf_from(2));
            o["vrf"] = vrf_proof(&sk, 5, "ts.test.near", id + 1000);
            o
        })));
    }
    {
        let (ai, xs, xr) = (ai.clone(), x_s.clone(), x_raw.clone());
        tries.push(("signature by a different key", Box::new(move |_, id| {
            let other = SigningKey::from_bytes(&Sha256::digest(b"not the outlayer key").into());
            let mut o = ai.good(&xs, &xr, &vrf_from(3));
            o["vrf"] = vrf_proof(&other, 5, "ts.test.near", id);
            o
        })));
    }
    {
        let (ai, sk, xs, xr) = (ai.clone(), sk.clone(), x_s.clone(), x_raw.clone());
        tries.push(("output that is not sha256(proof)", Box::new(move |_, id| {
            let mut o = ai.good(&xs, &xr, &vrf_from(4));
            let mut v = vrf_proof(&sk, 5, "ts.test.near", id);
            v["output_hex"] = json!(hex::encode([0xabu8; 32]));
            o["vrf"] = v;
            o
        })));
    }
    {
        let (ai, xs, xr) = (ai.clone(), x_s.clone(), x_raw.clone());
        tries.push(("VRF output without any proof (attacker picks the seed)", Box::new(move |_, _| {
            let mut o = ai.good(&xs, &xr, &vrf_from(5));
            o["vrf"]["signature_hex"] = json!(hex::encode([8u8; 64])); // not the fake marker: the harness must not "repair" it
            o
        })));
    }
    for (name, make) in tries {
        let before = w.bal(&w.bob).await?;
        let run = w.run_challenge(&w.bob, belt, &x_s, |id| make(req, id)).await?;
        let ch = w.challenge_view(run.id).await?;
        assert!(ch["status"] == "Refunded" || ch["status"] == "Rejected", "{name}: {ch}");
        assert_eq!(ch["code"], "E_VRF", "{name}: {ch}");
        assert!(u(&ch["storage_charge"]) > 0, "{name}: the failed challenge pays its storage");
        assert_eq!(w.bal(&w.bob).await?, before - w.opts.forge_fee - u(&ch["storage_charge"]), "{name}: toll minus fee and storage back");
        assert_eq!(w.stats().await?["bouts"], 0, "{name}: no bout from an unproven seed");
    }
    // a genuine proof for this very challenge resolves, and the seed comes from sha256(proof)
    let want_vrf: std::cell::Cell<[u8; 32]> = std::cell::Cell::new([0; 32]);
    let run = w
        .run_challenge(&w.bob, belt, &x_s, |id| {
            let mut o = ai.good(&x_s, &x_raw, &vrf_from(6));
            let p = vrf_proof(&sk, 77, "ts.test.near", id);
            let mut out32 = [0u8; 32];
            hex::decode_to_slice(p["output_hex"].as_str().unwrap(), &mut out32).unwrap();
            want_vrf.set(out32);
            o["vrf"] = p;
            let _ = (&champ, &chall, id);
            o
        })
        .await?;
    let ch = w.challenge_view(run.id).await?;
    assert_eq!(ch["status"], "Resolved", "{ch}");
    let fight = w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
    assert_eq!(fight["seed"], hex::encode(seed(&want_vrf.get(), run.id)), "seed derives from the verified VRF output");
    assert_eq!(fight["seed_source"], "vrf");
    Ok(())
}

#[tokio::test]
async fn concurrent_compiles_of_one_new_sentence_the_first_to_resolve_is_final_for_everyone() -> Result<()> {
    let w = World::new().await?;
    for a in [&w.bob, &w.carol] {
        w.deposit(a, 2 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (s, raw_a) = archetype("raccoon running a casino");
    let (_, raw_b) = archetype("cat who has already knocked");
    let arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    // both challenges start while the sentence is unknown, so both ask for a compile
    let (st_bob, req_bob, id_bob) = w.start_challenge(&w.bob, arena.belt, &s).await?;
    let (st_carol, req_carol, id_carol) = w.start_challenge(&w.carol, arena.belt, &s).await?;
    assert_eq!(w.request_input(req_bob).await?["need_compile"], true);
    assert_eq!(w.request_input(req_carol).await?["need_compile"], true);
    let champ = spec(&o_raw);
    // carol's answer (compile B) lands first, then bob's (compile A)
    let b = spec(&raw_b);
    w.answer(req_carol, &w.ai.good(&s, &raw_b, &find_vrf(&champ, &b, id_carol, None, Winner::Champion))).await?;
    w.finish(st_carol, id_carol).await?;
    let stored = w.view("get_fighter_by_sentence", json!({"sentence": s})).await?;
    assert_eq!(stored["writer"], w.carol.id().to_string());
    let rule = w.season(arena.belt).await?["rule"].as_u64().map(|r| r as u8);
    w.answer(req_bob, &w.ai.good(&s, &raw_a, &find_vrf(&champ, &b, id_bob, rule, Winner::Champion))).await?;
    w.finish(st_bob, id_bob).await?;
    let after = w.view("get_fighter_by_sentence", json!({"sentence": s})).await?;
    assert_eq!(after["spec"], stored["spec"], "the first paid forge of a sentence is final; the later compile must not replace it");
    assert_eq!(after["writer"], w.carol.id().to_string());
    for id in [id_bob, id_carol] {
        assert_eq!(w.challenge_view(id).await?["status"], "Resolved");
    }
    assert_eq!(after["record"]["losses"], 2, "one fighter, two bouts");
    Ok(())
}

#[tokio::test]
async fn protocol_share_is_withdrawable_by_the_owner_only_and_never_more_than_accrued() -> Result<()> {
    let w = World::new().await?;
    w.deposit(&w.bob, 2 * NEAR).await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let b = arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?;
    b.assert_as_asked();
    let accrued = b.split(w.opts.toll, w.opts.forge_fee).protocol;
    assert_eq!(u(&w.stats().await?["protocol_balance"]), accrued);
    assert_code(&w.call(&w.bob, "withdraw_protocol", json!({"to": w.bob.id(), "amount": null}), 1).await?, "E_NOT_OWNER", "non-owner");
    assert!(w.call(&w.owner, "withdraw_protocol", json!({"to": w.owner.id(), "amount": null}), 0).await?.is_failure(), "1 yocto required");
    let over = w.call(&w.owner, "withdraw_protocol", json!({"to": w.owner.id(), "amount": U(accrued + 1)}), 1).await?;
    assert!(over.is_failure(), "cannot withdraw more than the protocol accrued (that would be player money)");
    let part = accrued / 3;
    w.ok(&w.owner, "withdraw_protocol", json!({"to": w.owner.id(), "amount": U(part)}), 1).await?;
    assert_eq!(u(&w.stats().await?["protocol_balance"]), accrued - part);
    w.ok(&w.owner, "withdraw_protocol", json!({"to": w.owner.id(), "amount": null}), 1).await?;
    assert_eq!(u(&w.stats().await?["protocol_balance"]), 0);
    assert_eq!(u(&w.stats().await?["protocol_total"]), accrued, "lifetime total is unchanged by withdrawals");
    Ok(())
}

#[tokio::test]
async fn create_belt_is_owner_only_and_enforces_the_fee_bounds() -> Result<()> {
    let w = World::new().await?;
    let args = |toll: u128, fee: u128| json!({"name": "Test Belt", "promoter": w.promoter.id(), "toll": U(toll), "forge_fee": U(fee), "purse_chain_id": 84532});
    assert_code(&w.call(&w.bob, "create_belt", args(100 * MILLI, 10 * MILLI), 1).await?, "E_NOT_OWNER", "non-owner");
    assert!(w.call(&w.owner, "create_belt", args(100 * MILLI, 10 * MILLI), 0).await?.is_failure(), "1 yocto required");
    assert_code(&w.call(&w.owner, "create_belt", args(100 * MILLI, MIN_FORGE_FEE - 1), 1).await?, "E_FEE", "fee below the minimum");
    assert_code(&w.call(&w.owner, "create_belt", args(100 * MILLI, 100 * MILLI), 1).await?, "E_FEE", "fee equal to the toll");
    assert_code(&w.call(&w.owner, "create_belt", args(10 * MILLI, 20 * MILLI), 1).await?, "E_FEE", "fee above the toll");
    let ok = w.ok(&w.owner, "create_belt", args(MIN_FORGE_FEE + 1, MIN_FORGE_FEE), 1).await?;
    assert_eq!(ok.json::<u32>()?, 1, "belt ids start at 1");
    let sp = w.view("preview_split", json!({"belt_id": 1})).await?;
    let want = split(MIN_FORGE_FEE + 1, MIN_FORGE_FEE);
    assert_eq!((u(&sp["champion"]), u(&sp["promoter"]), u(&sp["side_pot"]), u(&sp["protocol"])), (want.champion, want.promoter, want.side_pot, want.protocol));
    assert_eq!(w.view("get_belts", json!({})).await?.as_array().unwrap().len(), 1);
    Ok(())
}
