//! NEAR AI compile cap (docs/BUDGET.md): counted at request time, refused with `E_FORGE_CLOSED` before any toll moves,
//! cached sentences never blocked, the daily counter rolls over on the UTC day of the block timestamp, the owner resets it.
use super::season_tests::msg;
use super::*;
use crate::compile_cap::DAY_NS;

/// The refusal code of a panicking call (the mocked VM wraps it in a HostError), else the whole message.
fn err<R>(f: impl FnOnce() -> R) -> String {
    let m = msg(f);
    match m.find("E_") {
        Some(i) => m[i..].chars().take_while(|c| c.is_ascii_uppercase() || *c == '_').collect(),
        None => m,
    }
}

fn caps(e: &Env) -> Value {
    near_sdk::serde_json::from_str(&e.c.get_compile_caps().0).unwrap()
}

fn set_caps(e: &mut Env, daily: u32, total: u32) {
    e.at("titleshot.testnet", 1);
    e.c.set_compile_caps(daily, total);
}

/// Seconds from the mocked clock to the next UTC day boundary.
fn to_next_day(e: &Env) -> u64 {
    let ns = e.t * 1_000_000_000;
    (DAY_NS - ns % DAY_NS) / 1_000_000_000
}

#[test]
fn defaults_are_60_a_day_and_250_in_total_and_only_the_owner_changes_them() {
    let mut e = Env::new("relayer");
    let v = caps(&e);
    assert_eq!((v["daily"].as_u64(), v["total"].as_u64(), v["today"].as_u64(), v["used"].as_u64()), (Some(60), Some(250), Some(0), Some(0)));
    assert_eq!(v["day"].as_u64(), Some(T0 / 86_400));
    assert_eq!(v["open"], true);
    e.at("bob.testnet", 1);
    assert_eq!(err(|| e.c.set_compile_caps(1, 1)), "E_NOT_OWNER");
    assert!(err(|| e.c.reset_compile_counter()).contains("E_NOT_OWNER"));
    e.at("titleshot.testnet", 0);
    assert!(err(|| e.c.set_compile_caps(1, 1)).contains("yocto"), "1 yocto required");
    assert!(err(|| e.c.reset_compile_counter()).contains("yocto"), "1 yocto required");
    set_caps(&mut e, 5, 9);
    assert_eq!((caps(&e)["daily"].as_u64(), caps(&e)["total"].as_u64()), (Some(5), Some(9)));
}

#[test]
fn the_daily_cap_refuses_a_new_compile_before_the_toll_moves_and_cached_sentences_still_play() {
    let mut e = Env::new("relayer");
    set_caps(&mut e, 2, 10);
    e.open_season("a promoter with a velvet microphone", 86_400, 0); // compile 1
    e.deposit("ann.testnet", 1);
    let a = e.challenge("ann.testnet", "a cactus that gives hugs"); // compile 2
    assert_eq!(e.deliver(a, "a cactus that gives hugs"), "Resolved");
    assert_eq!((caps(&e)["today"].as_u64(), caps(&e)["used"].as_u64(), caps(&e)["open"].as_bool()), (Some(2), Some(2), Some(false)));
    e.deposit("bob.testnet", 1);
    let (bal, tolls, next) = (e.bal("bob.testnet"), e.c.stats.tolls, e.c.next_challenge);
    e.at("bob.testnet", 0);
    assert_eq!(err(|| e.c.challenge(1, "a lighthouse afraid of the dark".into())), "E_FORGE_CLOSED");
    assert_eq!((e.bal("bob.testnet"), e.c.stats.tolls, e.c.next_challenge), (bal, tolls, next), "nothing debited, nothing created");
    assert!(e.c.pending.get(&acct("bob.testnet")).is_none());
    // A cached sentence (already forged) needs no compile: never blocked, never counted.
    let champ_is_ann = e.holder() == "ann.testnet";
    let cached = if champ_is_ann { "a promoter with a velvet microphone" } else { "a cactus that gives hugs" };
    let id = e.challenge("bob.testnet", cached);
    assert!(!e.c.challenges.get(&id).unwrap().need_compile);
    assert_eq!(caps(&e)["used"].as_u64(), Some(2), "a cached sentence is not counted");
    assert_eq!(e.bal("bob.testnet"), bal - TOLL);
}

#[test]
fn the_daily_counter_rolls_over_on_the_utc_day_of_the_block_timestamp() {
    let mut e = Env::new("relayer");
    set_caps(&mut e, 1, 10);
    e.open_season("a promoter with a velvet microphone", 30 * 86_400, 0);
    e.deposit("ann.testnet", 1);
    e.at("ann.testnet", 0);
    assert_eq!(err(|| e.c.challenge(1, "a cactus that gives hugs".into())), "E_FORGE_CLOSED");
    let day0 = caps(&e)["day"].as_u64().unwrap();
    let left = to_next_day(&e);
    e.advance(left - 1);
    e.at("ann.testnet", 0);
    assert_eq!(err(|| e.c.challenge(1, "a cactus that gives hugs".into())), "E_FORGE_CLOSED", "still the same UTC day");
    e.advance(1);
    e.at("anyone.testnet", 0);
    let v = caps(&e);
    assert_eq!((v["day"].as_u64(), v["today"].as_u64(), v["used"].as_u64(), v["open"].as_bool()), (Some(day0 + 1), Some(0), Some(1), Some(true)));
    let id = e.challenge("ann.testnet", "a cactus that gives hugs");
    assert!(e.c.challenges.get(&id).unwrap().need_compile);
    assert_eq!((caps(&e)["today"].as_u64(), caps(&e)["used"].as_u64()), (Some(1), Some(2)));
}

#[test]
fn the_total_cap_holds_across_days_until_the_owner_resets_the_counter() {
    let mut e = Env::new("relayer");
    set_caps(&mut e, 60, 2);
    e.open_season("a promoter with a velvet microphone", 30 * 86_400, 0);
    e.deposit("ann.testnet", 1);
    let a = e.challenge("ann.testnet", "a cactus that gives hugs");
    // A refunded compile stays counted: the paid call happened or may have happened.
    e.advance(601);
    e.at("anyone.testnet", 0);
    assert!(e.c.expire_challenge(a));
    assert_eq!(e.status(a), "Refunded");
    assert_eq!(caps(&e)["used"].as_u64(), Some(2), "a refund does not un-count");
    e.advance(3 * 86_400);
    e.at("ann.testnet", 0);
    assert_eq!(err(|| e.c.challenge(1, "a cactus that gives hugs".into())), "E_FORGE_CLOSED", "total cap ignores the new day");
    assert_eq!(caps(&e)["today"].as_u64(), Some(0));
    e.at("titleshot.testnet", 1);
    e.c.reset_compile_counter();
    let v = caps(&e);
    assert_eq!((v["today"].as_u64(), v["used"].as_u64(), v["daily"].as_u64(), v["total"].as_u64()), (Some(0), Some(0), Some(60), Some(2)));
    let id = e.challenge("ann.testnet", "a cactus that gives hugs");
    assert_eq!(e.deliver(id, "a cactus that gives hugs"), "Resolved");
    assert_eq!(caps(&e)["used"].as_u64(), Some(1));
}

#[test]
fn open_season_refuses_a_new_opener_compile_when_closed_but_cached_or_carried_openers_open() {
    let mut e = Env::new("relayer");
    e.open_season("a promoter with a velvet microphone", 60, 0);
    e.advance(61);
    e.at("anyone.testnet", 0);
    e.c.close_season(1);
    set_caps(&mut e, 0, 250);
    e.at("vance.testnet", FEE);
    assert_eq!(err(|| e.c.open_season(1, "a brand new opener sentence".into(), 600, U128(0))), "E_FORGE_CLOSED");
    assert_eq!(e.c.get_belt(1)["season"]["id"], 1, "no season was created");
    e.at("vance.testnet", FEE);
    assert_eq!(e.c.open_season(1, "a promoter with a velvet microphone".into(), 600, U128(0)), 2, "cached opener opens at once");
    assert_eq!(e.season()["state"], "Open");
    e.advance(601);
    e.at("anyone.testnet", 0);
    e.c.close_season(1);
    e.at("vance.testnet", 1);
    assert_eq!(e.c.open_season(1, "".into(), 600, U128(0)), 3, "carried champion opens at once");
    assert_eq!(caps(&e)["used"].as_u64(), Some(1));
}

#[test]
fn get_evm_address_returns_the_registered_address_lowercase_or_null() {
    let mut e = Env::new("relayer");
    assert_eq!(e.c.get_evm_address("alice.testnet".parse().unwrap()), None);
    e.at("alice.testnet", 1);
    e.c.set_evm_address("0xAbCdEf0123456789abcdef0123456789ABCDEF01".into());
    assert_eq!(e.c.get_evm_address("alice.testnet".parse().unwrap()).as_deref(), Some("0xabcdef0123456789abcdef0123456789abcdef01"));
    assert_eq!(e.c.get_evm_address("bob.testnet".parse().unwrap()), None);
}
