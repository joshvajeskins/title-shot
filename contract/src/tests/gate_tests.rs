//! Deploy gates: a misconfigured deploy must refuse `challenge` (E_NOT_READY) instead of running an unverified bout.
use super::season_tests::msg;
use super::*;

fn outlayer_with_champion() -> Env {
    let mut e = Env::new("outlayer");
    e.at("vance.testnet", FEE);
    e.c.open_season(1, "Opener behind the gates".into(), 3600, U128(0));
    let out = e.output("Opener behind the gates", &raw_for("Opener behind the gates"), true, 8);
    e.at("titleshot.testnet", 0);
    assert_eq!(e.c.settle(1, crate::forge_out::parse_str(&out), false), "Resolved");
    e.deposit("alice.testnet", 1);
    e
}

fn gate_names(e: &Env) -> Vec<String> {
    let g = e.c.get_deploy_gates();
    g["failing"].as_array().unwrap().iter().map(|r| r["gate"].as_str().unwrap().to_string()).collect()
}

#[test]
fn outlayer_challenge_is_refused_while_the_vrf_key_is_unpinned_and_runs_once_it_is_pinned() {
    let mut e = outlayer_with_champion();
    // Ready: the rig pinned the key; the only open gate is the (non-blocking) missing forge secrets profile.
    assert_eq!(gate_names(&e), vec!["forge_secrets"]);
    assert_eq!(e.c.get_deploy_gates()["ready"], true);
    e.at("titleshot.testnet", 1);
    e.c.set_vrf_pubkey(String::new());
    assert!(gate_names(&e).contains(&"vrf_pubkey".to_string()));
    assert_eq!(e.c.get_deploy_gates()["ready"], false);
    e.at("alice.testnet", 0);
    assert!(msg(|| e.c.challenge(1, "alice before the key is pinned".into())).contains("E_NOT_READY"));
    assert_eq!(e.bal("alice.testnet"), NEAR - 5_000_000_000_000_000_000_000, "a refused challenge costs nothing");
    e.at("titleshot.testnet", 1);
    e.c.set_vrf_pubkey(hex::encode(vrf_key().verifying_key().to_bytes()));
    e.at("alice.testnet", 0);
    assert_eq!(e.c.challenge(1, "alice after the key is pinned".into()), 2);
}

#[test]
fn an_empty_allowlist_or_unset_request_parts_also_block_challenges_in_every_mode() {
    for mode in ["relayer", "outlayer"] {
        let mut e = Env::new(mode);
        let before = gate_names(&e);
        assert!(!before.contains(&"allowlist".to_string()) && !before.contains(&"request".to_string()), "{mode}: {before:?}");
        e.c.allowlist.clear();
        assert!(gate_names(&e).contains(&"allowlist".to_string()), "{mode}");
        assert!(e.c.deploy_gates().iter().any(|g| g.blocking && g.name == "allowlist"));
        let mut e = Env::new(mode);
        e.c.req_suffix.clear();
        assert!(e.c.deploy_gates().iter().any(|g| g.blocking && g.name == "request"), "{mode}");
        e.at("alice.testnet", 0);
        assert!(msg(|| e.c.challenge(1, "alice with no request parts".into())).contains("E_NOT_READY"), "{mode}");
    }
}

#[test]
fn relayer_mode_needs_no_vrf_key_and_only_warns_about_the_block_seed() {
    let e = Env::new("relayer");
    assert_eq!(gate_names(&e), vec!["forge_mode"]);
    assert_eq!(e.c.get_deploy_gates()["ready"], true);
}
