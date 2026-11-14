//! Local diagnostic (not deployed as the project): GET the URL given on stdin ({"url":"..."}) with the forge's GET client and
//! report status, bytes and elapsed ms, to test how OutLayer's egress treats slow responses.
use std::time::{Duration, Instant};
fn main() {
    let mut raw = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw);
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    let url = v["url"].as_str().unwrap_or("https://httpbin.org/delay/10").to_string();
    let t = Instant::now();
    let r = wasi_http_client::Client::new().get(&url).connect_timeout(Duration::from_secs(8)).send();
    let out = match r {
        Ok(resp) => { let s = resp.status(); let n = resp.body().map(|b| b.len()).unwrap_or(0); serde_json::json!({"ok":true,"status":s,"bytes":n,"ms":t.elapsed().as_millis() as u64}) }
        Err(e) => serde_json::json!({"ok":false,"err":e.to_string(),"ms":t.elapsed().as_millis() as u64}),
    };
    print!("{out}");
}
