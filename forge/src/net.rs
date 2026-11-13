//! HTTP to NEAR AI Cloud (wasm only). Exact response bytes are kept: the signature covers them.
use std::time::{Duration, Instant};
use titleshot_forge::compile::{Http, Resp};
use titleshot_forge::input::Failure;
use crate::wasi_post;
use wasi_http_client::Client;

pub const HOST: &str = "https://cloud-api.near.ai";
pub const AUTHORITY: &str = "cloud-api.near.ai";

pub struct Net {
    pub start: Instant,
}

fn read(r: wasi_http_client::Response) -> Result<Resp, Failure> {
    let status = r.status();
    let body = r.body().map_err(|e| Failure::new("E_HTTP_BODY", e.to_string()))?;
    Ok(Resp { status, body })
}

/// Unauthenticated public GET (probe).
pub fn get_public(path: &str) -> Result<Resp, Failure> {
    let req = Client::new()
        .get(&format!("{HOST}{path}"))
        .connect_timeout(Duration::from_secs(8))
        .header("Accept-Encoding", "identity")
        .header("Accept", "application/json");
    read(req.send().map_err(|e| Failure::new("E_HTTP", e.to_string()))?)
}

impl Http for Net {
    fn get(&self, path_and_query: &str, key: &str) -> Result<Resp, Failure> {
        let req = Client::new()
            .get(&format!("{HOST}{path_and_query}"))
            .connect_timeout(Duration::from_secs(8))
            .header("Accept-Encoding", "identity")
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {key}"));
        read(req.send().map_err(|e| Failure::new("E_HTTP", e.to_string()))?)
    }

    fn post_json(&self, path: &str, key: &str, body: &[u8]) -> Result<Resp, Failure> {
        let headers = [
            ("Accept-Encoding", "identity".to_string()),
            ("Accept", "application/json".to_string()),
            ("Content-Type", "application/json".to_string()),
            ("x-no-aliasing", "true".to_string()),
            ("Content-Length", body.len().to_string()),
            ("Authorization", format!("Bearer {key}")),
        ];
        wasi_post::post(AUTHORITY, path, &headers, body, Duration::from_secs(8))
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}
