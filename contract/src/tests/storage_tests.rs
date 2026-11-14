//! Storage is paid by the toll: every byte a bout leaves behind is charged to it (capped), so the contract's
//! endowment never pays for players' history. Solvency in the real wasm is proven in the sandbox (t21).
use super::*;
use crate::economy::{split_toll, storage_charge, STORAGE_CAP_PCT};

fn fight_of(e: &Env, id: u64) -> near_sdk::serde_json::Value {
    let f = e.c.get_challenge(id).unwrap()["fight_id"].as_u64().unwrap();
    (*e.c.get_fight(f).unwrap()).clone()
}

#[test]
fn storage_charge_is_the_bytes_times_the_price_capped_at_half_of_the_toll_after_the_fee() {
    let cost = 10u128.pow(19);
    assert_eq!(storage_charge(90 * 10u128.pow(21), 2_000, cost), 2_000 * cost);
    assert_eq!(storage_charge(90 * 10u128.pow(21), 0, cost), 0);
    for r in [0u128, 1, 99, 10u128.pow(22), 90 * 10u128.pow(21), u128::MAX / 4] {
        for bytes in [0u64, 1, 500, 2_500, 100_000, u64::MAX] {
            let c = storage_charge(r, bytes, cost);
            assert!(c <= r / 100 * STORAGE_CAP_PCT, "charge {c} exceeds the cap for r {r}");
            assert!(c <= bytes as u128 * cost);
            // The split of what is left still conserves the toll: fee + charge + shares == toll.
            if let Some(s) = split_toll(r + 7, 7 + c) {
                assert_eq!(s.total() + 7 + c, r + 7);
            }
        }
    }
}

#[test]
fn after_many_challenges_the_storage_components_cover_every_byte_the_bouts_stored() {
    let mut e = Env::new("relayer");
    e.open_season("The reigning storage clerk", 86_400, 0);
    let who: Vec<String> = (0..30).map(|i| format!("fan{i}.testnet")).collect();
    for w in &who {
        e.deposit(w, 1);
    }
    let cost = near_sdk::env::storage_byte_cost().as_yoctonear();
    e.at("titleshot.testnet", 0);
    let bytes0 = near_sdk::env::storage_usage();
    let (mut charged, mut first_bytes, mut repeat_bytes) = (0u128, 0u64, 0u64);
    for i in 0..30u32 {
        let who = &who[i as usize];
        // Every fifth challenge repeats an earlier sentence (unless it is the champion's own): no new fighter, a smaller bill.
        let mut sentence = format!("challenger {} with an unusual hat", if i % 5 == 4 { i - 4 } else { i });
        if e.c.get_belt(1)["champion"]["sentence"] == sentence.as_str() {
            sentence = format!("fresh challenger {i} with an unusual hat");
        }
        let repeat = e.c.get_fighter_by_sentence(sentence.clone()).is_some();
        let before = e.c.stats()["bouts"].as_u64().unwrap();
        let id = e.challenge(who, &sentence);
        assert_eq!(e.deliver(id, &sentence), "Resolved", "challenge {i}");
        let fight = fight_of(&e, id);
        let (storage, bytes) = (fight["storage"].as_str().unwrap().parse::<u128>().unwrap(), fight["storage_bytes"].as_u64().unwrap());
        assert_eq!(storage, bytes as u128 * cost, "the toll is large enough to pay every byte in full");
        assert_eq!(e.c.stats()["bouts"].as_u64().unwrap(), before + 1);
        charged += storage;
        if repeat {
            repeat_bytes = bytes;
        } else if i == 0 {
            first_bytes = bytes;
        }
    }
    assert!(repeat_bytes < first_bytes, "a cached fighter stores less ({repeat_bytes} B) than a new one ({first_bytes} B)");
    e.at("titleshot.testnet", 0);
    let stored = near_sdk::env::storage_usage() - bytes0;
    let sol = e.c.get_solvency();
    assert_eq!(sol["storage_charged"], charged.to_string());
    assert_eq!(sol["storage_debt"], "0", "no bout stored more than it could be charged");
    assert!(charged >= stored as u128 * cost, "components {charged} cover all {stored} stored bytes ({} yocto)", stored as u128 * cost);
    assert_eq!(e.c.stats()["storage_charged"], charged.to_string());
}

#[test]
fn a_toll_too_small_for_the_storage_records_the_shortfall_as_debt_and_never_charges_more_than_the_cap() {
    let mut e = Env::new("relayer");
    e.at("titleshot.testnet", 1);
    // 0.012 NEAR toll, 0.01 fee: 0.002 NEAR left, far less than a bout's storage.
    e.c.create_belt("Tiny Belt".into(), acct("vance.testnet"), U128(NEAR / 1000 * 12), U128(FEE), 84532);
    e.at("vance.testnet", FEE);
    e.c.open_season(2, "Opener of the tiny belt".into(), 3600, U128(0));
    let cid = e.c.next_challenge - 1;
    let out = e.output("Opener of the tiny belt", &raw_for("Opener of the tiny belt"), true, 9);
    e.at("relayer.testnet", 0);
    assert_eq!(e.c.submit_forge(cid, out), "Resolved");
    e.deposit("alice.testnet", 1);
    e.at("alice.testnet", 0);
    let s = "alice at the tiny belt";
    let id = e.c.challenge(2, s.into());
    let out = e.output(s, &raw_for(s), true, 9);
    e.at("relayer.testnet", 0);
    assert_eq!(e.c.submit_forge(id, out), "Resolved");
    let fight = fight_of(&e, id);
    let storage: u128 = fight["storage"].as_str().unwrap().parse().unwrap();
    let r = NEAR / 1000 * 2;
    assert_eq!(storage, r / 100 * STORAGE_CAP_PCT, "capped at half of what the toll leaves after the fee");
    let debt: u128 = e.c.get_solvency()["storage_debt"].as_str().unwrap().parse().unwrap();
    assert!(debt > 0, "the uncharged storage is reported, not hidden");
    let champion_share = fight["split"]["champion"].as_str().unwrap().parse::<u128>().unwrap();
    assert_eq!(champion_share, (r - storage) * 60 / 100);
}
