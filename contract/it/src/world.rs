//! A fresh sandbox per test: the real titleshot wasm, outlayer-mock, signer-mock and a cast of accounts.
//! Async flows: `challenge`/`open_season` park on the mock's yielded promise, so they are sent with
//! `transact_async`, the "worker" (the test) answers through the mock, then the original tx is awaited so
//! its final result carries every receipt (the callback's logs and gas).
use crate::fixtures::Ai;
use crate::util::*;
use anyhow::{anyhow, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub fn wasm(rel: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    let p = match (rel.ends_with("titleshot.wasm"), std::env::var("TITLESHOT_WASM")) {
        (true, Ok(over)) => PathBuf::from(over),
        _ => p,
    };
    std::fs::read(&p).unwrap_or_else(|_| panic!("missing {}: build it first (contract/build.sh, contract/mocks/build.sh)", p.display()))
}

#[derive(Clone)]
pub struct Opts {
    pub forge_mode: &'static str,
    pub kind: &'static str,
    pub delay_sec: u64,
    pub toll: u128,
    pub forge_fee: u128,
    /// What the mock OutLayer keeps per run (the rest of the deposit is refunded to the contract).
    pub charge: u128,
    pub purse_chain_id: u64,
}

impl Default for Opts {
    fn default() -> Self {
        Self { forge_mode: "outlayer", kind: "provider_tee", delay_sec: 120, toll: 100 * MILLI, forge_fee: 10 * MILLI, charge: 4 * MILLI, purse_chain_id: 84532 }
    }
}

pub struct World {
    pub w: Worker<Sandbox>,
    pub root: Account,
    pub ts: Contract,
    pub ol: Contract,
    pub sg: Contract,
    pub owner: Account,
    pub promoter: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
    pub relayer: Account,
    pub ai: Ai,
    pub opts: Opts,
}

/// One answered async flow.
#[derive(Clone)]
pub struct Run {
    pub id: u64,
    pub req: u64,
    pub input: Value,
    pub res: ExecutionFinalResult,
}

impl Run {
    /// Gas burnt by the `on_forged` callback: the last receipt on the contract that logged an event
    /// (gas-refund receipts, which log nothing, are skipped).
    pub fn callback_gas(&self, ts: &str) -> f64 {
        let g = self.res.outcomes().iter().filter(|o| o.executor_id.as_str() == ts && !o.logs.is_empty()).last().map(|o| o.gas_burnt);
        g.map(tgas).unwrap_or(0.0)
    }
}

impl World {
    pub async fn new() -> Result<World> {
        Self::with(Opts::default()).await
    }

    pub async fn with(opts: Opts) -> Result<World> {
        let w = near_workspaces::sandbox().await?;
        let root = w.root_account()?;
        let mk = |name: &'static str, n: u128| {
            let root = root.clone();
            async move { Ok::<_, anyhow::Error>(root.create_subaccount(name).initial_balance(NearToken::from_yoctonear(n * NEAR)).transact().await?.into_result()?) }
        };
        let ts = mk("ts", 120).await?;
        let ol = mk("ol", 40).await?;
        let sg = mk("sg", 40).await?;
        let (owner, promoter) = (mk("owner", 30).await?, mk("vance", 60).await?);
        let (alice, bob, carol, relayer) = (mk("alice", 80).await?, mk("bob", 80).await?, mk("carol", 80).await?, mk("relayer", 20).await?);
        let ts = ts.deploy(&wasm("../res/titleshot.wasm")).await?.into_result()?;
        let ol = ol.deploy(&wasm("../mocks/outlayer-mock/target/near/outlayer_mock.wasm")).await?.into_result()?;
        let sg = sg.deploy(&wasm("../mocks/signer-mock/target/near/signer_mock.wasm")).await?.into_result()?;
        ol.call("new").args_json(json!({"charge": U(opts.charge), "min_deposit": U(5 * MILLI)})).transact().await?.into_result()?;
        sg.call("new").transact().await?.into_result()?;
        let ai = Ai::new(opts.kind);
        let (prefix, suffix) = ai.parts_b64();
        ts.call("new")
            .args_json(json!({
                "owner": owner.id(), "outlayer": ol.id(), "forge_project": "titleshot.testnet/forge", "mpc_signer": sg.id(),
                "model_id": ai.model, "req_prefix": prefix, "req_suffix": suffix, "signature_kind": opts.kind,
                "signer_allowlist": ai.allowlist(), "forge_mode": opts.forge_mode, "allowlist_delay_sec": opts.delay_sec,
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(World { w, root, ts, ol, sg, owner, promoter, alice, bob, carol, relayer, ai, opts })
    }

    // ----- plain calls and views -----

    pub async fn call(&self, who: &Account, method: &str, args: Value, deposit: u128) -> Result<ExecutionFinalResult> {
        let fut = who.call(self.ts.id(), method).args_json(args).deposit(NearToken::from_yoctonear(deposit)).gas(Gas::from_tgas(300)).transact();
        Ok(tokio::time::timeout(Duration::from_secs(120), fut).await.map_err(|_| anyhow!("{method} by {} hung for 120 s", who.id()))??)
    }

    /// Like `call`, but the run must succeed.
    pub async fn ok(&self, who: &Account, method: &str, args: Value, deposit: u128) -> Result<ExecutionFinalResult> {
        let r = self.call(who, method, args, deposit).await?;
        if r.is_failure() {
            return Err(anyhow!("{method} by {} failed: {}", who.id(), failure_text(&r)));
        }
        Ok(r)
    }

    pub async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.ts.view(method).args_json(args).await?.json()?)
    }

    pub async fn bal(&self, a: &Account) -> Result<u128> {
        Ok(u(&self.view("balance_of", json!({"account": a.id()})).await?))
    }

    pub async fn native(&self, a: &Account) -> Result<u128> {
        Ok(a.view_account().await?.balance.as_yoctonear())
    }

    pub async fn deposit(&self, a: &Account, amount: u128) -> Result<()> {
        let _ = self.ok(a, "deposit", json!({}), amount).await?;
        Ok(())
    }

    /// The belt's current season object (from get_belt).
    pub async fn season(&self, belt: u32) -> Result<Value> {
        Ok(self.view("get_belt", json!({"id": belt})).await?["season"].clone())
    }

    pub async fn stats(&self) -> Result<Value> {
        self.view("stats", json!({})).await
    }

    pub async fn challenge_view(&self, id: u64) -> Result<Value> {
        self.view("get_challenge", json!({"id": id})).await
    }

    // ----- setup helpers -----

    pub async fn create_belt(&self) -> Result<u32> {
        let o = &self.opts;
        let r = self
            .ok(&self.owner, "create_belt", json!({"name":"Midnight Heavyweight","promoter":self.promoter.id(),"toll":U(o.toll),"forge_fee":U(o.forge_fee),"purse_chain_id":o.purse_chain_id}), 1)
            .await?;
        Ok(r.json::<u32>()?)
    }

    pub async fn owner_call(&self, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        self.call(&self.owner, method, args, 1).await
    }

    /// Belt, opener forged and champion set, season open for `duration_sec`. Returns (belt id, opener run).
    pub async fn open_belt(&self, opener: &str, raw: &Value, duration_sec: u64, purse_wei: u128) -> Result<(u32, Run)> {
        let belt = self.create_belt().await?;
        let run = self.open_season(belt, opener, raw, duration_sec, purse_wei).await?;
        Ok((belt, run))
    }

    pub async fn open_season(&self, belt: u32, opener: &str, raw: &Value, duration_sec: u64, purse_wei: u128) -> Result<Run> {
        let prev = self.last_request().await?;
        let st = self
            .promoter
            .call(self.ts.id(), "open_season")
            .args_json(json!({"belt_id":belt,"opener_sentence":opener,"duration_sec":duration_sec,"purse_wei":U(purse_wei)}))
            .deposit(NearToken::from_yoctonear(self.opts.forge_fee))
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?;
        let req = self.wait_request(prev).await?;
        let input = self.request_input(req).await?;
        let vrf = crate::simx::vrf_from(9_000_000 + req);
        self.answer(req, &self.ai.good(opener, raw, &vrf)).await?;
        let id = input["challenge_id"].as_u64().unwrap_or(0);
        let res = self.finish(st, id).await?;
        Ok(Run { id, req, input, res })
    }
}

/// U128 as the JSON string the contract expects.
#[allow(non_snake_case)]
pub fn U(v: u128) -> String {
    v.to_string()
}
