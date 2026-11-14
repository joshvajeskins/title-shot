//! Native tests. `economy_tests`: pure rules. The others drive the real contract through the mocked
//! blockchain in relayer mode (and outlayer mode where noted) with a throwaway signer that plays NEAR AI.
mod economy_tests;
mod flow_tests;
mod gate_tests;
mod guard_tests;
mod review_tests;
mod season_tests;
mod storage_tests;

use crate::economy::clean_sentence;
use crate::Contract;
use bout_sim::rng::Rng;
use bout_sim::testgen::random_raw;
use k256::ecdsa::SigningKey;
use crate::b64::B64;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

pub const MODEL: &str = "Qwen/Qwen3.8-27B";
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const TOLL: u128 = NEAR / 10;
pub const FEE: u128 = NEAR / 100;
pub const T0: u64 = 1_800_000_000;

pub fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

pub fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

pub fn sha(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

pub fn eth_addr(sk: &SigningKey) -> [u8; 20] {
    let pt = sk.verifying_key().to_encoded_point(false);
    keccak(&pt.as_bytes()[1..])[12..].try_into().unwrap()
}

pub fn eip191_sign(sk: &SigningKey, text: &str) -> String {
    let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    m.extend_from_slice(text.as_bytes());
    let (sig, rec) = sk.sign_prehash_recoverable(&keccak(&m)).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + rec.to_byte());
    hex::encode(out)
}

/// Deterministic fighter for a sentence (what a well-behaved model would return).
pub fn raw_for(sentence: &str) -> String {
    let mut rng = Rng::from_seed(&sha(sentence.as_bytes()));
    near_sdk::serde_json::to_string(&random_raw(&mut rng, true)).unwrap()
}

pub struct Env {
    pub c: Contract,
    pub sk: SigningKey,
    pub t: u64,
    pub seed: u8,
}

/// The OutLayer VRF key of the native tests (pinned by `Env::new("outlayer")`).
pub fn vrf_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&sha(b"titleshot-unit-vrf-key"))
}

/// A genuine proof for `challenge_id`: alpha is `vrf:{request}:{sender}:titleshot-challenge-{id}`, output = sha256(signature).
pub fn vrf_proof(challenge_id: u64) -> Value {
    use ed25519_dalek::Signer;
    let alpha = format!("vrf:7:titleshot.testnet:titleshot-challenge-{challenge_id}");
    let sig = vrf_key().sign(alpha.as_bytes()).to_bytes();
    json!({ "output_hex": hex::encode(sha(&sig)), "alpha": alpha, "signature_hex": hex::encode(sig) })
}

pub fn signing_key(n: u8) -> SigningKey {
    SigningKey::from_slice(&[n; 32]).unwrap()
}

impl Env {
    pub fn new(mode: &str) -> Env {
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let sk = signing_key(7);
        let (prefix, suffix) = bout_sim::rulebook::request_parts(MODEL);
        testing_env!(VMContextBuilder::new().current_account_id(acct("titleshot.testnet")).predecessor_account_id(acct("titleshot.testnet")).build());
        let c = Contract::new(
            acct("titleshot.testnet"),
            acct("outlayer.testnet"),
            "titleshot-forge".into(),
            acct("v1.signer-prod.testnet"),
            MODEL.into(),
            B64(prefix),
            B64(suffix),
            "provider_tee".into(),
            vec![format!("0x{}", hex::encode(eth_addr(&sk)))],
            mode.into(),
            3600,
        );
        let mut e = Env { c, sk, t: T0, seed: 1 };
        e.at("titleshot.testnet", 1);
        e.c.add_relayer(acct("relayer.testnet"));
        e.c.create_belt("Heavy Metal Belt".into(), acct("vance.testnet"), U128(TOLL), U128(FEE), 84532);
        if mode == "outlayer" {
            e.c.set_vrf_pubkey(hex::encode(vrf_key().verifying_key().to_bytes()));
        }
        e
    }

    /// Switch the mocked environment: caller, attached deposit (yocto), time (self.t) and block seed.
    pub fn at(&mut self, who: &str, deposit: u128) {
        self.seed = self.seed.wrapping_add(1);
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("titleshot.testnet"))
            .predecessor_account_id(acct(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(self.t * 1_000_000_000)
            .random_seed([self.seed; 32])
            .prepaid_gas(near_sdk::Gas::from_tgas(300))
            .build());
    }

    pub fn advance(&mut self, secs: u64) {
        self.t += secs;
    }

    pub fn deposit(&mut self, who: &str, near: u128) {
        self.at(who, near * NEAR);
        self.c.deposit();
    }

    pub fn bal(&self, who: &str) -> u128 {
        self.c.balance(&acct(who))
    }

    /// A signed forge output as OutLayer would return it. `ai` false = VRF only (cached sentence).
    pub fn output(&self, sentence: &str, raw: &str, ai: bool, vrf_tag: u8) -> String {
        let s = clean_sentence(sentence).unwrap();
        let mut o = json!({ "ok": true, "vrf": { "output_hex": hex::encode([vrf_tag; 32]), "alpha": "x", "signature_hex": hex::encode([1u8; 64]) }, "extra_field": 1 });
        if ai {
            let response = json!({ "id": "chatcmpl-test", "model": MODEL, "choices": [{ "index": 0, "finish_reason": "stop",
                "message": { "role": "assistant", "content": raw } }] })
            .to_string();
            let req = bout_sim::rulebook::build_request(MODEL, &s);
            let text = format!("{MODEL}:{}:{}", hex::encode(sha(&req)), hex::encode(sha(response.as_bytes())));
            o["response"] = Value::String(response);
            o["signature"] = Value::String(eip191_sign(&self.sk, &text));
            o["signing_algo"] = "ecdsa".into();
            o["signature_kind"] = "provider_tee".into();
            o["signing_address"] = format!("0x{}", hex::encode(eth_addr(&self.sk))).into();
        }
        o.to_string()
    }

    /// `out` (a forge output) carrying a genuine VRF proof for challenge `id`.
    pub fn proved(&self, out: &str, id: u64) -> String {
        let mut o: Value = near_sdk::serde_json::from_str(out).unwrap();
        o["vrf"] = vrf_proof(id);
        o.to_string()
    }

    /// Promoter opens a season with `sentence` (relayer mode) and the relayer delivers the opener compile.
    pub fn open_season(&mut self, sentence: &str, duration: u64, purse: u128) -> u32 {
        self.at("vance.testnet", FEE);
        let id = self.c.open_season(1, sentence.into(), duration, U128(purse));
        let cid = self.c.next_challenge - 1;
        let out = self.output(sentence, &raw_for(sentence), true, 9);
        self.at("relayer.testnet", 0);
        assert_eq!(self.c.submit_forge(cid, out), "Resolved");
        id
    }

    pub fn challenge(&mut self, who: &str, sentence: &str) -> u64 {
        self.at(who, 0);
        self.c.challenge(1, sentence.into())
    }

    /// Relayer delivers a compile for challenge `id` (always carries the AI part).
    pub fn deliver(&mut self, id: u64, sentence: &str) -> String {
        let out = self.output(sentence, &raw_for(sentence), true, id as u8);
        self.at("relayer.testnet", 0);
        self.c.submit_forge(id, out)
    }

    pub fn status(&self, id: u64) -> String {
        self.c.get_challenge(id).unwrap()["status"].as_str().unwrap().to_string()
    }

    pub fn season(&self) -> Value {
        self.c.get_belt(1)["season"].clone()
    }

    pub fn holder(&self) -> String {
        self.c.holder(1).to_string()
    }
}
