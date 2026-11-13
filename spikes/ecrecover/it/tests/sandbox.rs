//! Sandbox tests with the real wasm (contract/target/near/ecrecover_spike.wasm).
//! Runs every case of every vectors/{synthetic,nearai}-*.json twice: as a view and as a real
//! transaction (to measure gas). Writes spikes/ecrecover/gas-report.json.
use near_workspaces::types::Gas;
use serde_json::{json, Value};
use std::path::PathBuf;

const GAS_BUDGET_TGAS: f64 = 15.0;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn wasm() -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contract/target/near/ecrecover_spike.wasm"))
        .expect("build the wasm first: contract/build.sh")
}
fn vector_files() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(std::env::var("VECTORS_DIR").map(PathBuf::from).unwrap_or_else(|_| root().join("vectors")))
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            n.ends_with(".json") && (n.starts_with("synthetic-") || n.starts_with("nearai-"))
        })
        .collect();
    v.sort();
    v
}
fn args(case: &Value) -> Value {
    json!({"sentence":case["sentence"],"response":case["response"],"signature_hex":case["signature_hex"],
           "signing_algo":case["signing_algo"],"signature_kind":case["signature_kind"]})
}

async fn deploy(vec: &Value) -> anyhow::Result<(near_workspaces::Worker<near_workspaces::network::Sandbox>, near_workspaces::Contract)> {
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()).await?;
    c.call("new")
        .args_json(json!({"allowlist":vec["allowlist"],"prefix":vec["prefix_b64"],"suffix":vec["suffix_b64"],"model_id":vec["model_id"]}))
        .transact()
        .await?
        .into_result()?;
    Ok((worker, c))
}

#[tokio::test]
async fn every_vector_case_view_and_tx_with_gas() -> anyhow::Result<()> {
    let files = vector_files();
    assert!(!files.is_empty(), "no vectors found");
    let mut report = vec![];
    for f in files {
        let vec: Value = serde_json::from_str(&std::fs::read_to_string(&f)?)?;
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let (_w, c) = deploy(&vec).await?;
        let cfg: Value = c.view("get_config").await?.json()?;
        assert_eq!(cfg["model_id"], vec["model_id"]);
        assert_eq!(cfg["allowlist"], vec["allowlist"]);
        for case in vec["cases"].as_array().unwrap() {
            let cname = case["name"].as_str().unwrap();
            let want = &case["expect"];
            let viewed: Value = c.view("verify_forge").args_json(args(case)).await?.json()?;
            assert_eq!(viewed["code"], want["code"], "{name}/{cname} (view) -> {viewed}");
            assert_eq!(viewed["ok"], want["ok"], "{name}/{cname} (view)");
            if want["ok"] == true {
                assert_eq!(viewed["content"], want["content"], "{name}/{cname} content");
                assert!(viewed["signer"].as_str().unwrap().eq_ignore_ascii_case(vec["allowlist"][0].as_str().unwrap()));
            }
            let tx = c.call("verify_forge").args_json(args(case)).gas(Gas::from_tgas(300)).transact().await?;
            assert!(tx.is_success(), "{name}/{cname} tx failed: {:?}", tx.failures());
            let txr: Value = tx.clone().json()?;
            assert_eq!(txr["code"], want["code"], "{name}/{cname} (tx)");
            let tgas = tx.total_gas_burnt.as_gas() as f64 / 1e12;
            println!("{name:34} {cname:44} {:>6} {tgas:7.2} Tgas", want["code"].as_str().unwrap());
            if want["ok"] == true {
                assert!(tgas < GAS_BUDGET_TGAS, "{cname}: {tgas} Tgas over budget");
            }
            report.push(json!({"vector":name,"case":cname,"code":want["code"],"tgas":(tgas*100.0).round()/100.0}));
        }
    }
    let max_ok = report.iter().filter(|r| r["code"] == "OK").map(|r| r["tgas"].as_f64().unwrap()).fold(0.0, f64::max);
    println!("max OK-path gas: {max_ok} Tgas (budget {GAS_BUDGET_TGAS})");
    if std::env::var("VECTORS_DIR").is_err() { std::fs::write(root().join("spikes/ecrecover/gas-report.json"), serde_json::to_string_pretty(&report)? + "\n")?; }
    Ok(())
}

#[tokio::test]
async fn init_guards_and_single_init() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()).await?;
    let bad = c.call("new").args_json(json!({"allowlist":["0x1234"],"prefix":"YQ==","suffix":"Yg==","model_id":"m"})).transact().await?;
    assert!(bad.is_failure(), "bad address must fail init");
    let empty = c.call("new").args_json(json!({"allowlist":[],"prefix":"YQ==","suffix":"Yg==","model_id":"m"})).transact().await?;
    assert!(empty.is_failure(), "empty allowlist must fail init");
    let addr = "0x835ab53d20294ef795906dff21ae4c045336aa26";
    c.call("new").args_json(json!({"allowlist":[addr],"prefix":"YQ==","suffix":"Yg==","model_id":"m"})).transact().await?.into_result()?;
    let again = c.call("new").args_json(json!({"allowlist":[addr],"prefix":"YQ==","suffix":"Yg==","model_id":"m"})).transact().await?;
    assert!(again.is_failure(), "second init must fail");
    Ok(())
}
