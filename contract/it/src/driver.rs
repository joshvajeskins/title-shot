//! Async flows on `World`: relayer mode, parked OutLayer requests, answering them as the worker, settling the tx
//! tree, chain time and function-call keys.
use crate::util::*;
use crate::world::{Run, World, U};
use anyhow::{anyhow, Result};
use near_workspaces::operations::TransactionStatus;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};
use std::time::Duration;

impl World {
    // ----- relayer mode -----

    pub async fn add_relayer(&self) -> Result<()> {
        let _ = self.ok(&self.owner, "add_relayer", json!({"acct": self.relayer.id()}), 1).await?;
        Ok(())
    }

    /// `submit_forge` as `who` (default: the relayer).
    pub async fn submit_forge(&self, who: &Account, id: u64, out: &Value) -> Result<ExecutionFinalResult> {
        self.call(who, "submit_forge", json!({"challenge_id": id, "output_json": out.to_string()}), 0).await
    }

    /// Relayer-mode opener: open_season, then the relayer delivers the compile. Returns the opener's challenge id.
    pub async fn open_season_relayer(&self, belt: u32, opener: &str, raw: &Value, duration_sec: u64, purse_wei: u128) -> Result<u64> {
        let r = self
            .ok(&self.promoter, "open_season", json!({"belt_id":belt,"opener_sentence":opener,"duration_sec":duration_sec,"purse_wei":U(purse_wei)}), self.opts.forge_fee)
            .await?;
        let id = event(&r, "forge_requested").ok_or_else(|| anyhow!("no forge_requested event: {:?}", r.logs()))?["challenge_id"].as_u64().unwrap();
        let out = self.ai.good(opener, raw, &crate::simx::vrf_from(9_100_000 + id));
        let s = self.submit_forge(&self.relayer, id, &out).await?;
        if s.is_failure() {
            return Err(anyhow!("opener submit_forge failed: {}", failure_text(&s)));
        }
        Ok(id)
    }

    // ----- async challenge flow -----

    pub async fn last_request(&self) -> Result<u64> {
        Ok(self.ol.view("last_request_id").await?.json::<u64>()?)
    }

    pub async fn wait_request(&self, prev: u64) -> Result<u64> {
        for _ in 0..120 {
            let n = self.last_request().await?;
            if n > prev {
                return Ok(n);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(anyhow!("no OutLayer request appeared after request {prev}"))
    }

    pub async fn request(&self, req: u64) -> Result<Value> {
        Ok(self.ol.view("get_request").args_json(json!({"request_id": req})).await?.json()?)
    }

    pub async fn request_input(&self, req: u64) -> Result<Value> {
        let r = self.request(req).await?;
        Ok(serde_json::from_str(r["input_data"].as_str().ok_or_else(|| anyhow!("request {req} has no input_data"))?)?)
    }

    /// The worker answers `req` with `output`. Returns whether it was delivered to the contract's promise.
    pub async fn answer(&self, req: u64, output: &Value) -> Result<bool> {
        self.answer_raw(req, &output.to_string()).await
    }

    pub async fn answer_raw(&self, req: u64, output: &str) -> Result<bool> {
        let output = &self.with_proof(req, output).await?;
        for _ in 0..40 {
            let r = self.ol.call("resolve").args_json(json!({"request_id":req,"output_json":output})).transact().await?;
            if r.is_failure() {
                return Err(anyhow!("resolve failed: {}", failure_text(&r)));
            }
            if r.json::<bool>()? {
                return Ok(true);
            }
            if self.request(req).await?["status"] == "TooLate" {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(anyhow!("request {req} never became resolvable"))
    }

    /// A VRF block carrying the fake marker signature gets a genuine proof for the challenge `req` was made for (the
    /// contract pins the OutLayer key, so an unproven seed is refused). Anything else, hostile proofs included, goes as is.
    async fn with_proof(&self, req: u64, output: &str) -> Result<String> {
        let Ok(mut v) = serde_json::from_str::<Value>(output) else { return Ok(output.to_string()) };
        if v["vrf"]["signature_hex"] != hex::encode(crate::simx::FAKE_SIG) {
            return Ok(output.to_string());
        }
        let input = self.request_input(req).await?;
        let id = input["challenge_id"].as_u64().ok_or_else(|| anyhow!("request {req} has no challenge_id"))?;
        v["vrf"] = crate::simx::proof_json(req, self.ts.id().as_str(), id).0;
        Ok(v.to_string())
    }

    /// Execution failure on the worker side: the callback sees a failed promise.
    pub async fn fail_request(&self, req: u64) -> Result<()> {
        for _ in 0..40 {
            let r = self.ol.call("fail").args_json(json!({"request_id":req})).transact().await?;
            if r.is_success() && r.json::<bool>()? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(anyhow!("could not fail request {req}"))
    }

    /// Send `challenge` and park until the contract has asked OutLayer. Returns (tx status, request id, challenge id).
    pub async fn start_challenge(&self, who: &Account, belt: u32, sentence: &str) -> Result<(TransactionStatus, u64, u64)> {
        let prev = self.last_request().await?;
        let st = who.call(self.ts.id(), "challenge").args_json(json!({"belt_id":belt,"sentence":sentence})).gas(Gas::from_tgas(300)).transact_async().await?;
        let req = self.wait_request(prev).await?;
        let input = self.request_input(req).await?;
        let id = input["challenge_id"].as_u64().ok_or_else(|| anyhow!("request input has no challenge_id: {input}"))?;
        Ok((st, req, id))
    }

    /// Challenge, let `out(challenge_id)` build the worker's answer, deliver it, await everything.
    pub async fn run_challenge(&self, who: &Account, belt: u32, sentence: &str, out: impl FnOnce(u64) -> Value) -> Result<Run> {
        let (st, req, id) = self.start_challenge(who, belt, sentence).await?;
        let input = self.request_input(req).await?;
        self.answer(req, &out(id)).await?;
        let res = self.finish(st, id).await?;
        Ok(Run { id, req, input, res })
    }

    /// Wait until challenge `id` has left `Forging` (the callback ran), then return the tx's complete receipt tree.
    /// (`TransactionStatus::await` can return before detached callbacks have executed.)
    pub async fn finish(&self, st: TransactionStatus, id: u64) -> Result<ExecutionFinalResult> {
        for _ in 0..160 {
            let c = self.challenge_view(id).await?;
            if !c.is_null() && c["status"] != "Forging" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        self.settled(st).await
    }

    /// Poll the tx until its receipt tree stops growing. Every RPC call is bounded: after a fast-forward the sandbox
    /// can leave a status request hanging, which must never hang the test.
    pub async fn settled(&self, st: TransactionStatus) -> Result<ExecutionFinalResult> {
        self.settled_within(st, 60).await.ok_or_else(|| anyhow!("transaction never settled"))
    }

    /// Like `settled`, but gives up after `polls` polls and returns what was seen (None if nothing).
    pub async fn settled_within(&self, st: TransactionStatus, polls: usize) -> Option<ExecutionFinalResult> {
        let (mut last, mut stable) = (usize::MAX, 0);
        let mut best: Option<ExecutionFinalResult> = None;
        for _ in 0..polls {
            if let Ok(Ok(std::task::Poll::Ready(r))) = tokio::time::timeout(Duration::from_secs(6), st.status()).await {
                let n = r.receipt_outcomes().len();
                best = Some(r);
                if n == last {
                    stable += 1;
                    if stable >= 2 {
                        break;
                    }
                } else {
                    stable = 0;
                    last = n;
                }
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        best
    }

    // ----- time -----

    pub async fn now_ns(&self) -> Result<u64> {
        Ok(self.w.view_block().await?.timestamp())
    }

    /// Fast-forward until the chain clock is `secs` later (sandbox runs ~0.3 s of chain time per block).
    pub async fn advance_secs(&self, secs: u64) -> Result<()> {
        let target = self.now_ns().await? + secs * 1_000_000_000;
        while self.now_ns().await? < target {
            let left = (target - self.now_ns().await?) / 1_000_000_000;
            self.w.fast_forward((left * 3).clamp(20, 3000)).await?;
        }
        Ok(())
    }

    // ----- keys -----

    /// A key for `who` that can only call `methods` on the contract (the in-browser game key).
    pub async fn fc_key(&self, who: &Account, methods: &[&str]) -> Result<Account> {
        let sk = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        who.batch(who.id()).add_key(sk.public_key(), AccessKey::function_call_access(self.ts.id(), methods, None)).transact().await?.into_result()?;
        Ok(Account::from_secret_key(who.id().clone(), sk, &self.w))
    }
}
