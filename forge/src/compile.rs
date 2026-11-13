//! The AI step, generic over the transport so it is host-testable with recorded responses.
use crate::input::Failure;
use crate::output::{expected_text, Signed};
use crate::request;
use serde_json::Value;

pub struct Resp {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait Http {
    fn post_json(&self, path: &str, key: &str, body: &[u8]) -> Result<Resp, Failure>;
    fn get(&self, path_and_query: &str, key: &str) -> Result<Resp, Failure>;
    fn sleep_ms(&self, ms: u64);
    /// Milliseconds since the run started.
    fn elapsed_ms(&self) -> u64;
}

/// Whole run budget (the caller's OutLayer limit is max_execution_seconds = 60).
pub const BUDGET_MS: u64 = 40_000;
const SIG_ATTEMPTS: u32 = 5;

fn check_budget<H: Http>(h: &H) -> Result<(), Failure> {
    if h.elapsed_ms() > BUDGET_MS {
        return Err(Failure::new("E_TIMEOUT", format!("{} ms", h.elapsed_ms())));
    }
    Ok(())
}

/// POST the chat completion, fetch the ECDSA signature over the exact bytes, self-check the text.
pub fn compile<H: Http>(h: &H, key: &str, model_id: &str, sentence: &str) -> Result<Signed, Failure> {
    let body = request::build_body(model_id, sentence);
    check_budget(h)?;
    let resp = h.post_json("/v1/chat/completions", key, &body)?;
    if resp.status != 200 {
        let d = String::from_utf8_lossy(&resp.body).chars().take(120).collect::<String>();
        return Err(Failure::new("E_AI_STATUS", format!("{} {}", resp.status, d)));
    }
    let response = String::from_utf8(resp.body.clone())
        .map_err(|_| Failure::new("E_AI_UTF8", "response not utf-8"))?;
    let id = serde_json::from_str::<Value>(&response)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        .filter(|id| !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .ok_or_else(|| Failure::new("E_AI_NO_ID", "response has no usable id"))?;
    let sig = fetch_signature(h, &id, model_id, key)?;
    let field = |k: &str| sig.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (text, signature, address, algo, kind) = (
        field("text"),
        field("signature"),
        field("signing_address"),
        field("signing_algo"),
        field("signature_kind"),
    );
    if algo != "ecdsa" {
        return Err(Failure::new("E_SIG_ALGO", algo));
    }
    // Docs: never infer the kind from the shape of `text`; it must be stated and match its rule.
    if expected_text(&kind, model_id, &body, &resp.body).as_deref() != Some(text.as_str()) {
        return Err(Failure::new("E_SIG_TEXT", format!("kind '{kind}' does not match the signed text")));
    }
    Ok(Signed { response, signature, signing_address: address, signing_algo: algo, signature_kind: kind, text })
}

/// GET /v1/signature/{id}?signing_algo=ecdsa. Per the docs: 404 = not recorded yet (bounded retry),
/// a 2xx carrying `error_code` is "unavailable", not a signature. The last attempt also sends model=.
fn fetch_signature<H: Http>(h: &H, id: &str, model_id: &str, key: &str) -> Result<Value, Failure> {
    let mut last_status = 0;
    for attempt in 0..SIG_ATTEMPTS {
        check_budget(h)?;
        let q = if attempt == SIG_ATTEMPTS - 1 {
            format!("/v1/signature/{id}?signing_algo=ecdsa&model={model_id}")
        } else {
            format!("/v1/signature/{id}?signing_algo=ecdsa")
        };
        let r = h.get(&q, key)?;
        last_status = r.status;
        if r.status == 200 {
            if let Ok(v) = serde_json::from_slice::<Value>(&r.body) {
                if v.get("error_code").is_none() && v.get("signature").is_some() {
                    return Ok(v);
                }
            }
        }
        if attempt + 1 < SIG_ATTEMPTS {
            h.sleep_ms(700);
        }
    }
    Err(Failure::new("E_SIG_STATUS", format!("{last_status}")))
}
