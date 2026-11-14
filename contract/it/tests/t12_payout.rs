#![allow(unused_must_use)]
//! Test 12: Chain Signatures payouts. sign_payout nonce sequencing, idempotent re-sign, higher-fee re-sign,
//! gas bounds, recovered-address check, claim_payout by the payee only. The tx is decoded and its digest rebuilt
//! with code that shares nothing with the contract.
use anyhow::Result;
use bout_sim::types::Winner;
use serde_json::{json, Value};
use titleshot_it::evm::{address_from_derived_key, addr_bytes, decode, Tx};
use titleshot_it::flows::Arena;
use titleshot_it::simx::archetype;
use titleshot_it::util::*;
use titleshot_it::world::{World, U};

const PURSE: u128 = 10_000_000_000_000_000;
const GWEI: u128 = 1_000_000_000;
const ALICE_EVM: &str = "0x00000000000000000000000000000000a11ce000";
const VANCE_EVM: &str = "0x000000000000000000000000000000000000a4ce";
const SIGN_GAS_LIMIT: u64 = 60_000;

struct Setup {
    w: World,
    purse_addr: String,
    /// (payout id, payee)
    alice_payout: u64,
    vance_payout: u64,
}

/// bob loses to the promoter (a defence), alice takes the belt, bell, close: payees = promoter (capped) and alice.
async fn setup() -> Result<Setup> {
    let w = World::new().await?;
    for a in [&w.alice, &w.bob] {
        w.deposit(a, 2 * NEAR).await?;
    }
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let (x_s, x_raw) = archetype("raccoon running a casino");
    let (y_s, y_raw) = archetype("cat who has already knocked");
    let mut arena = Arena::open(&w, (&o_s, &o_raw), 240, PURSE).await?;
    let pk: String = w.sg.view("derived_public_key").args_json(json!({"path": "belt-1-s1", "predecessor": w.ts.id(), "domain_id": 0})).await?.json()?;
    let purse_addr = address_from_derived_key(&pk);
    w.ok(&w.promoter, "set_purse_address", json!({"belt": arena.belt, "season": 1, "addr": purse_addr}), 1).await?;
    arena.fight(&w.bob, (&x_s, &x_raw), Winner::Champion).await?.assert_as_asked();
    arena.fight(&w.alice, (&y_s, &y_raw), Winner::Challenger).await?.assert_as_asked();
    w.ok(&w.alice, "set_evm_address", json!({"addr": ALICE_EVM}), 1).await?;
    w.advance_secs(245).await?;
    w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?;
    let payouts = w.view("get_payouts", json!({"belt": arena.belt, "season": 1})).await?;
    let id_of = |who: &str| payouts.as_array().unwrap().iter().find(|p| p["payee"] == who).unwrap()["id"].as_u64().unwrap();
    let (alice_payout, vance_payout) = (id_of(w.alice.id().as_str()), id_of(w.promoter.id().as_str()));
    Ok(Setup { w, purse_addr, alice_payout, vance_payout })
}

async fn sign(s: &Setup, id: u64, max_fee: u128, prio: u128, gas: u64) -> Result<near_workspaces::result::ExecutionFinalResult> {
    // The payee signs with their own parameters; a stranger would be clamped to a 1% gas burn (see t18 and t20).
    let who = if id == s.alice_payout { &s.w.alice } else if id == s.vance_payout { &s.w.promoter } else { &s.w.bob };
    s.w.call(who, "sign_payout", json!({"payout_id": id, "max_fee_per_gas": U(max_fee), "max_priority_fee_per_gas": U(prio), "gas_limit": gas}), 0).await
}

async fn payout(s: &Setup, id: u64) -> Result<Value> {
    s.w.view("get_payout", json!({"payout_id": id})).await
}

fn amount(p: &Value) -> u128 {
    u(&p["amount_wei"])
}

#[tokio::test]
async fn sign_payout_builds_the_exact_eip1559_tx_signed_by_the_purse_key_with_sequential_nonces() -> Result<()> {
    let s = setup().await?;
    let w = &s.w;
    let a = payout(&s, s.alice_payout).await?;
    assert_eq!(a["to"], ALICE_EVM, "payee's registered EVM address");
    assert!(a["nonce"].is_null(), "nonce is assigned on first sign");
    let (fee, prio) = (2 * GWEI, GWEI / 10);
    let r = sign(&s, s.alice_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    assert!(r.is_success(), "sign_payout: {}", failure_text(&r));
    assert_eq!(count_events(&r, "payout_signed"), 1);
    let p = payout(&s, s.alice_payout).await?;
    let raw = p["raw_tx"].as_str().expect("raw tx stored");
    let d = decode(raw);
    let want = Tx {
        chain_id: 84532,
        nonce: 0,
        max_priority_fee_per_gas: prio,
        max_fee_per_gas: fee,
        gas_limit: SIGN_GAS_LIMIT,
        to: addr_bytes(ALICE_EVM),
        value: amount(&p) - SIGN_GAS_LIMIT as u128 * fee,
    };
    assert_eq!(d.tx, want, "fields of the signed transaction (the payee pays gas out of the payout)");
    assert_eq!(p["nonce"], 0);
    assert_eq!(u(&p["value_wei"]), want.value);
    assert_eq!(format!("0x{}", hex::encode(d.sender)), s.purse_addr, "recovered sender == the purse address derived from belt-1-s1");
    // what the signer was asked to sign: keccak(0x02 || rlp(fields)), 1 yocto, the purse path, domain 0
    let calls: Vec<Value> = w.sg.view("get_calls").await?.json()?;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["payload_hex"], hex::encode(want.digest()), "digest handed to the MPC signer == independent EIP-1559 digest");
    assert_eq!(calls[0]["path"], "belt-1-s1");
    assert_eq!(calls[0]["domain_id"], 0);
    assert_eq!(calls[0]["deposit"], "1");
    assert_eq!(calls[0]["caller"], w.ts.id().to_string());
    // reference raw tx built from the same (r, s, parity) is byte-identical (RLP integer trimming included)
    assert_eq!(hex::encode(want.raw(d.parity, &d.r, &d.s)), raw.trim_start_matches("0x"));
    // the second payee gets the next nonce, same purse key
    let r2 = sign(&s, s.vance_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    assert_code(&r2, "E_NO_ADDRESS", "promoter has not registered an EVM address yet");
    assert!(payout(&s, s.vance_payout).await?["nonce"].is_null(), "a refused sign must not burn a nonce");
    w.ok(&w.promoter, "claim_payout", json!({"payout_id": s.vance_payout, "addr": VANCE_EVM}), 1).await?;
    let r3 = sign(&s, s.vance_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    assert!(r3.is_success(), "{}", failure_text(&r3));
    let pv = payout(&s, s.vance_payout).await?;
    let dv = decode(pv["raw_tx"].as_str().unwrap());
    assert_eq!(dv.tx.nonce, 1, "nonces are sequential per purse address");
    assert_eq!(dv.tx.to, addr_bytes(VANCE_EVM));
    assert_eq!(dv.sender, d.sender);
    println!("GAS sign_payout: tx total {:.1} Tgas", tgas(r.total_gas_burnt));
    Ok(())
}

#[tokio::test]
async fn re_sign_with_the_same_parameters_returns_the_stored_tx_without_calling_the_signer() -> Result<()> {
    let s = setup().await?;
    let (fee, prio) = (2 * GWEI, GWEI / 10);
    sign(&s, s.alice_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    let first = payout(&s, s.alice_payout).await?["raw_tx"].clone();
    assert!(first.is_string());
    let calls0: u64 = s.w.sg.view("call_count").await?.json()?;
    let again = sign(&s, s.alice_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    assert!(again.is_success(), "{}", failure_text(&again));
    assert_eq!(payout(&s, s.alice_payout).await?["raw_tx"], first, "same stored tx");
    assert_eq!(s.w.sg.view("call_count").await?.json::<u64>()?, calls0, "no new signature requested");
    assert_eq!(payout(&s, s.alice_payout).await?["nonce"], 0, "nonce unchanged");
    Ok(())
}

#[tokio::test]
async fn stuck_tx_is_re_signed_on_the_same_nonce_only_with_a_strictly_higher_max_fee() -> Result<()> {
    let s = setup().await?;
    let (fee, prio) = (2 * GWEI, GWEI / 10);
    sign(&s, s.alice_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    let first = payout(&s, s.alice_payout).await?;
    let d1 = decode(first["raw_tx"].as_str().unwrap());
    for (f, why) in [(fee - 1, "lower"), (fee / 2, "half")] {
        let r = sign(&s, s.alice_payout, f, prio, SIGN_GAS_LIMIT).await?;
        assert_code(&r, "E_FEE_NOT_HIGHER", &format!("{why} max fee"));
    }
    assert_eq!(payout(&s, s.alice_payout).await?["raw_tx"], first["raw_tx"], "refused re-signs keep the stored tx");
    let higher = fee + fee / 8 + 1; // +12.5%
    let r = sign(&s, s.alice_payout, higher, prio, SIGN_GAS_LIMIT).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    let second = payout(&s, s.alice_payout).await?;
    let d2 = decode(second["raw_tx"].as_str().unwrap());
    assert_eq!(d2.tx.nonce, d1.tx.nonce, "replacement uses the same nonce");
    assert_eq!(d2.tx.max_fee_per_gas, higher);
    assert_eq!(d2.tx.value, amount(&second) - SIGN_GAS_LIMIT as u128 * higher, "value recomputed for the new fee");
    assert_ne!(second["raw_tx"], first["raw_tx"]);
    assert_eq!(d2.sender, d1.sender);
    assert_eq!(u(&second["attempt"]), u(&first["attempt"]) + 1, "attempt counter increments by one per replacement");
    assert_eq!(s.w.sg.view("call_count").await?.json::<u64>()?, 2);
    // the next payee still gets nonce 1: the bump did not consume a nonce
    s.w.ok(&s.w.promoter, "claim_payout", json!({"payout_id": s.vance_payout, "addr": VANCE_EVM}), 1).await?;
    sign(&s, s.vance_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    assert_eq!(decode(payout(&s, s.vance_payout).await?["raw_tx"].as_str().unwrap()).tx.nonce, 1);
    Ok(())
}

#[tokio::test]
async fn sign_payout_refuses_out_of_bounds_gas_dust_missing_address_and_unknown_payout() -> Result<()> {
    let s = setup().await?;
    let (fee, prio) = (2 * GWEI, GWEI / 10);
    let bad = [
        (21_000 - 1, fee, prio, "gas below 21000"),
        (150_001, fee, prio, "gas above 150000"),
        (SIGN_GAS_LIMIT, 50 * GWEI + 1, prio, "max fee above 50 gwei"),
        (SIGN_GAS_LIMIT, fee, 50 * GWEI + 1, "priority fee above 50 gwei"),
    ];
    for (gas, f, p, why) in bad {
        let r = sign(&s, s.alice_payout, f, p, gas).await?;
        assert_code(&r, "E_GAS", why);
    }
    assert_code(&sign(&s, 9_999, fee, prio, SIGN_GAS_LIMIT).await?, "E_NO_PAYOUT", "unknown payout id");
    // boundaries are accepted
    let r = sign(&s, s.alice_payout, 50 * GWEI, 50 * GWEI, 21_000).await?;
    assert!(r.is_success(), "21000 gas and 50 gwei are inside the bounds: {}", failure_text(&r));
    // dust: the promoter's 0.0025 ETH payout cannot pay 150000 gas at 50 gwei (0.0075 ETH)
    s.w.ok(&s.w.promoter, "claim_payout", json!({"payout_id": s.vance_payout, "addr": VANCE_EVM}), 1).await?;
    let v = amount(&payout(&s, s.vance_payout).await?);
    assert!(v < 150_000 * 50 * GWEI);
    assert_code(&sign(&s, s.vance_payout, 50 * GWEI, 50 * GWEI, 150_000).await?, "E_DUST", "payout smaller than the gas it must pay");
    assert!(payout(&s, s.vance_payout).await?["nonce"].is_null(), "dust refusal burns no nonce");
    Ok(())
}

#[tokio::test]
async fn sign_payout_without_a_purse_address_is_refused() -> Result<()> {
    let w = World::new().await?;
    let (o_s, o_raw) = archetype("hedgehog in samurai armor");
    let arena = Arena::open(&w, (&o_s, &o_raw), 60, PURSE).await?;
    w.ok(&w.promoter, "set_evm_address", json!({"addr": VANCE_EVM}), 1).await?;
    w.advance_secs(65).await?;
    let ids = w.ok(&w.bob, "close_season", json!({"belt_id": arena.belt}), 0).await?.json::<Vec<u64>>()?;
    let r = w.call(&w.bob, "sign_payout", json!({"payout_id": ids[0], "max_fee_per_gas": U(2 * GWEI), "max_priority_fee_per_gas": U(GWEI), "gas_limit": 60_000}), 0).await?;
    assert_code(&r, "E_NO_ADDRESS", "purse address never recorded for the season");
    assert_eq!(w.sg.view("call_count").await?.json::<u64>()?, 0, "the signer was not asked");
    Ok(())
}

#[tokio::test]
async fn signature_from_another_key_or_malformed_signature_is_never_stored_and_the_payout_can_be_retried() -> Result<()> {
    let s = setup().await?;
    let (fee, prio) = (2 * GWEI, GWEI / 10);
    for mode in ["wrong_key", "high_s", "bad_recovery", "fail"] {
        s.w.sg.call("set_mode").args_json(json!({"mode": mode})).transact().await?.into_result()?;
        let r = sign(&s, s.alice_payout, fee, prio, SIGN_GAS_LIMIT).await?;
        // callbacks are soft: the call may succeed with a null result, or fail; either way nothing is stored
        let p = payout(&s, s.alice_payout).await?;
        assert!(p["raw_tx"].is_null(), "{mode}: a signature that does not recover to the purse address must not be stored (run: {:?})", r.logs());
        assert_eq!(p["signing"], false, "{mode}: signing lock released so the payout can be retried");
        assert_eq!(count_events(&r, "payout_signed"), 0, "{mode}: no payout_signed event");
    }
    s.w.sg.call("set_mode").args_json(json!({"mode": "normal"})).transact().await?.into_result()?;
    let r = sign(&s, s.alice_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    let p = payout(&s, s.alice_payout).await?;
    let d = decode(p["raw_tx"].as_str().expect("signed after the signer behaves"));
    assert_eq!(format!("0x{}", hex::encode(d.sender)), s.purse_addr);
    // other payees still get a gap-free nonce stream
    s.w.ok(&s.w.promoter, "claim_payout", json!({"payout_id": s.vance_payout, "addr": VANCE_EVM}), 1).await?;
    sign(&s, s.vance_payout, fee, prio, SIGN_GAS_LIMIT).await?;
    let mut nonces = vec![d.tx.nonce, decode(payout(&s, s.vance_payout).await?["raw_tx"].as_str().unwrap()).tx.nonce];
    nonces.sort();
    assert_eq!(nonces, vec![0, 1], "no nonce gap after failed attempts");
    Ok(())
}

#[tokio::test]
async fn claim_payout_by_the_payee_only_with_a_valid_address_and_never_overwrites_a_registered_one() -> Result<()> {
    let s = setup().await?;
    let w = &s.w;
    let id = s.vance_payout;
    let claim = |who: &near_workspaces::Account, addr: &str| {
        let who = who.clone();
        let addr = addr.to_string();
        async move { w.call(&who, "claim_payout", json!({"payout_id": id, "addr": addr}), 1).await }
    };
    assert_code(&claim(&w.bob, VANCE_EVM).await?, "E_NOT_PAYEE", "a stranger claiming the promoter's payout");
    assert_code(&claim(&w.alice, VANCE_EVM).await?, "E_NOT_PAYEE", "another payee claiming it");
    assert!(payout(&s, id).await?["to"].is_null(), "nobody but the payee can set the destination");
    assert!(claim(&w.promoter, "0x1234").await?.is_failure(), "short address refused");
    assert!(claim(&w.promoter, "not-an-address").await?.is_failure(), "non-hex refused");
    let no_yocto = w.call(&w.promoter, "claim_payout", json!({"payout_id": id, "addr": VANCE_EVM}), 0).await?;
    assert!(no_yocto.is_failure(), "claim_payout needs exactly 1 yocto (a function-call key cannot redirect a payout)");
    assert_code(&w.call(&w.promoter, "claim_payout", json!({"payout_id": 4242, "addr": VANCE_EVM}), 1).await?, "E_NO_PAYOUT", "unknown payout");
    let ok = claim(&w.promoter, VANCE_EVM).await?;
    assert!(ok.is_success(), "{}", failure_text(&ok));
    assert_eq!(payout(&s, id).await?["to"], VANCE_EVM);
    let again = claim(&w.promoter, "0x00000000000000000000000000000000000000bb").await?;
    assert!(again.is_failure(), "a registered destination cannot be redirected by a second claim");
    assert_eq!(payout(&s, id).await?["to"], VANCE_EVM);
    // the payout that already had an address (alice registered before the bell) cannot be redirected either
    let redirect = w.call(&w.alice, "claim_payout", json!({"payout_id": s.alice_payout, "addr": VANCE_EVM}), 1).await?;
    assert!(redirect.is_failure());
    assert_eq!(payout(&s, s.alice_payout).await?["to"], ALICE_EVM);
    // address registration guards
    assert!(w.call(&w.carol, "set_evm_address", json!({"addr": "0xzz"}), 1).await?.is_failure());
    assert!(w.call(&w.carol, "set_evm_address", json!({"addr": VANCE_EVM}), 0).await?.is_failure(), "1 yocto required");
    Ok(())
}
