#![allow(unused_must_use)]
//! Test 3: full challenge -> forged -> bout (lose, win, draw), balances to the yocto.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::json;
use titleshot_it::expect::split;
use titleshot_it::flows::Arena;
use titleshot_it::simx::{archetype, sentence_hash, winner_name};
use titleshot_it::snap::{assert_bout_money, snap};
use titleshot_it::util::*;
use titleshot_it::world::World;

async fn setup() -> Result<World> {
    let w = World::new().await?;
    w.deposit(&w.bob, NEAR).await?;
    w.deposit(&w.carol, NEAR).await?;
    Ok(w)
}

#[tokio::test]
async fn champion_wins_bout_toll_splits_60_25_10_5_to_the_yocto_and_belt_stays() -> Result<()> {
    let w = setup().await?;
    let (o_s, o_raw) = archetype("retired lighthouse keeper");
    let (c_s, c_raw) = archetype("pigeon with a law degree");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let (toll, fee) = (w.opts.toll, w.opts.forge_fee);
    let sp = split(toll, fee);
    let before = snap(&w, arena.belt, &[&w.bob, &w.promoter]).await?;
    let b = arena.fight(&w.bob, (&c_s, &c_raw), Winner::Champion).await?;
    assert!(b.run.res.is_success(), "challenge tx: {}", failure_text(&b.run.res));
    b.assert_as_asked();
    b.assert_replay();
    let (id, vrf, rule, state_hash) = (b.run.id, b.vrf, b.rule, b.state_hash);
    let after = snap(&w, arena.belt, &[&w.bob, &w.promoter]).await?;
    assert_bout_money(&before, &after, &sp, toll, fee, &w.bob, &w.promoter, &w.promoter);
    let ch = w.challenge_view(id).await?;
    assert_eq!(ch["status"], "Resolved", "{ch}");
    let fight = w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
    assert_eq!(fight["winner"], "champion");
    assert_eq!(fight["seed"], hex::encode(titleshot_it::simx::seed(&vrf, id)), "seed = sha256(domain|vrf|id_le)");
    assert_eq!(fight["rule"], rule, "sealed rule = seed[0] % 8");
    assert_eq!(fight["state_hash"], hex::encode(state_hash), "in-contract bout must equal the native replay (same crate)");
    assert_eq!(fight["holder"], w.promoter.id().to_string());
    assert_eq!(u(&fight["split"]["champion"]), sp.champion);
    assert_eq!(u(&fight["split"]["promoter"]), sp.promoter);
    assert_eq!(u(&fight["split"]["side_pot"]), sp.side_pot);
    assert_eq!(u(&fight["split"]["protocol"]), sp.protocol);
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt["holder"], w.promoter.id().to_string(), "belt stays with the champion");
    assert_eq!(belt["defences"], 1);
    let loser = w.view("get_fighter_by_sentence", json!({"sentence": c_s})).await?;
    assert_eq!(loser["record"]["losses"], 1);
    let champ = w.view("get_fighter_by_sentence", json!({"sentence": o_s})).await?;
    assert_eq!(champ["record"]["wins"], 1);
    let b = arena.bouts.last().unwrap();
    assert_eq!(count_events(&b.run.res, "bout"), 1);
    assert_eq!(count_events(&b.run.res, "rule_revealed"), 1);
    println!("GAS champion_wins: tx total {:.1} Tgas, on_forged {:.1} Tgas", tgas(b.run.res.total_gas_burnt), b.run.callback_gas("ts.test.near"));
    Ok(())
}

#[tokio::test]
async fn challenger_wins_bout_belt_nft_moves_defences_reset_and_next_toll_pays_new_holder() -> Result<()> {
    let w = setup().await?;
    let (o_s, o_raw) = archetype("retired lighthouse keeper");
    let (c_s, c_raw) = archetype("world's angriest goose");
    let (d_s, d_raw) = archetype("very polite kraken");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let (toll, fee) = (w.opts.toll, w.opts.forge_fee);
    let sp = split(toll, fee);
    let belt0 = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt0["holder"], w.promoter.id().to_string());
    let before = snap(&w, arena.belt, &[&w.bob, &w.promoter, &w.carol]).await?;
    let b = arena.fight(&w.bob, (&c_s, &c_raw), Winner::Challenger).await?;
    assert!(b.run.res.is_success());
    b.assert_as_asked();
    let (id, rule, title_events) = (b.run.id, b.rule, count_events(&b.run.res, "title_change"));
    let mid = snap(&w, arena.belt, &[&w.bob, &w.promoter, &w.carol]).await?;
    // the old champion (holder when the bout resolved) is paid for being the target, win or lose
    assert_bout_money(&before, &mid, &sp, toll, fee, &w.bob, &w.promoter, &w.promoter);
    let ch = w.challenge_view(id).await?;
    let fight = w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
    assert_eq!(fight["winner"], "challenger");
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt["holder"], w.bob.id().to_string(), "belt moves to the winner");
    assert_eq!(belt["defences"], 0, "defence streak resets on a title change");
    assert_eq!(belt["champion"]["hash"], sentence_hash(&c_s));
    assert!(u(&belt["reign_since"]) > u(&belt0["reign_since"]));
    let token: serde_json::Value = w.ts.view("nft_token").args_json(json!({"token_id": format!("belt-{}", arena.belt)})).await?.json()?;
    assert_eq!(token["owner_id"], w.bob.id().to_string(), "NEP-171 owner follows the title");
    assert_eq!(title_events, 1, "one title_change event");
    // next bout: carol loses to the NEW holder; bob gets the champion share, the promoter only the promoter share
    let b2 = arena.fight(&w.carol, (&d_s, &d_raw), Winner::Champion).await?;
    assert!(b2.run.res.is_success());
    b2.assert_as_asked();
    let (id2, count) = (b2.run.id, count_events(&b2.run.res, "rule_revealed"));
    let after = snap(&w, arena.belt, &[&w.bob, &w.promoter, &w.carol]).await?;
    assert_bout_money(&mid, &after, &sp, toll, fee, &w.carol, &w.bob, &w.promoter);
    let fight2 = w.view("get_fight", json!({"id": w.challenge_view(id2).await?["fight_id"]})).await?;
    assert_eq!(fight2["rule"], rule, "the season rule is fixed after the first bout (revealed once)");
    assert_eq!(count, 0);
    Ok(())
}

#[tokio::test]
async fn drawn_bout_is_a_defence_champion_keeps_belt_and_is_paid() -> Result<()> {
    let w = setup().await?;
    let (o_s, o_raw) = archetype("golden retriever");
    let (c_s, c_raw) = archetype("overworked wedding planner");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 3600, 10u128.pow(16)).await?;
    let (toll, fee) = (w.opts.toll, w.opts.forge_fee);
    let sp = split(toll, fee);
    let before = snap(&w, arena.belt, &[&w.bob, &w.promoter]).await?;
    let b = arena.fight(&w.bob, (&c_s, &c_raw), Winner::Draw).await?;
    assert!(b.run.res.is_success());
    b.assert_as_asked();
    let id = b.run.id;
    let after = snap(&w, arena.belt, &[&w.bob, &w.promoter]).await?;
    assert_bout_money(&before, &after, &sp, toll, fee, &w.bob, &w.promoter, &w.promoter);
    let ch = w.challenge_view(id).await?;
    let fight = w.view("get_fight", json!({"id": ch["fight_id"]})).await?;
    assert_eq!(fight["winner"], winner_name(Winner::Draw));
    let belt = w.view("get_belt", json!({"id": arena.belt})).await?;
    assert_eq!(belt["holder"], w.promoter.id().to_string(), "a draw keeps the belt with the champion");
    assert_eq!(belt["defences"], 1, "a draw counts as a defence");
    let dc = belt["season"]["defence_count"].as_array().unwrap();
    assert_eq!(dc.len(), 1);
    assert_eq!(dc[0]["account"], w.promoter.id().to_string());
    assert_eq!(dc[0]["defences"], 1);
    for s in [&o_s, &c_s] {
        assert_eq!(w.view("get_fighter_by_sentence", json!({"sentence": s})).await?["record"]["draws"], 1);
    }
    Ok(())
}
