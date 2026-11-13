use crate::compile::*;
use crate::input::Failure;
use crate::output::{expected_text, sha256_hex};
use crate::request::build_body;
use std::cell::{Cell, RefCell};

const MODEL: &str = "anthropic/claude-fable-5";
const SENT: &str = "A baker who fights with rolling pins";
const RESP: &str = "{\"id\":\"chatcmpl-abc123\",\"model\":\"anthropic/claude-fable-5\",\"choices\":[{\"message\":{\"content\":\"{}\"}}]}";

struct Mock {
    ai_status: u16,
    ai_body: String,
    /// Signature responses served in order; the last repeats.
    sigs: RefCell<Vec<(u16, String)>>,
    gets: RefCell<Vec<String>>,
    now: Cell<u64>,
    step_ms: u64,
}

impl Mock {
    fn new(sigs: Vec<(u16, String)>) -> Self {
        Mock { ai_status: 200, ai_body: RESP.into(), sigs: RefCell::new(sigs), gets: RefCell::default(), now: Cell::new(0), step_ms: 0 }
    }
}

impl Http for Mock {
    fn post_json(&self, path: &str, key: &str, body: &[u8]) -> Result<Resp, Failure> {
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(key, "k");
        assert_eq!(body, build_body(MODEL, SENT).as_slice());
        self.now.set(self.now.get() + self.step_ms);
        Ok(Resp { status: self.ai_status, body: self.ai_body.clone().into_bytes() })
    }
    fn get(&self, q: &str, _key: &str) -> Result<Resp, Failure> {
        self.gets.borrow_mut().push(q.to_string());
        self.now.set(self.now.get() + self.step_ms);
        let mut s = self.sigs.borrow_mut();
        let (status, body) = if s.len() > 1 { s.remove(0) } else { s[0].clone() };
        Ok(Resp { status, body: body.into_bytes() })
    }
    fn sleep_ms(&self, ms: u64) {
        self.now.set(self.now.get() + ms);
    }
    fn elapsed_ms(&self) -> u64 {
        self.now.get()
    }
}

fn sig_json(kind: &str, text: &str) -> String {
    serde_json::json!({"text": text, "signature": format!("0x{}", "ab".repeat(65)), "signing_address": format!("0x{}", "cd".repeat(20)),
        "signing_algo": "ecdsa", "signature_kind": kind})
    .to_string()
}

fn good_text(kind: &str) -> String {
    expected_text(kind, MODEL, &build_body(MODEL, SENT), RESP.as_bytes()).unwrap()
}

#[test]
fn provider_tee_signature_is_accepted_and_response_bytes_kept_exact() {
    let m = Mock::new(vec![(200, sig_json("provider_tee", &good_text("provider_tee")))]);
    let s = compile(&m, "k", MODEL, SENT).unwrap();
    assert_eq!(s.response, RESP);
    assert_eq!(s.signature_kind, "provider_tee");
    assert!(s.text.starts_with(&format!("{MODEL}:{}", sha256_hex(&build_body(MODEL, SENT)))));
    assert_eq!(m.gets.borrow()[0], "/v1/signature/chatcmpl-abc123?signing_algo=ecdsa");
}

#[test]
fn gateway_signature_is_accepted() {
    let m = Mock::new(vec![(200, sig_json("gateway", &good_text("gateway")))]);
    assert_eq!(compile(&m, "k", MODEL, SENT).unwrap().signature_kind, "gateway");
}

#[test]
fn signature_404_is_retried_then_succeeds() {
    let m = Mock::new(vec![(404, "{}".into()), (404, "{}".into()), (200, sig_json("gateway", &good_text("gateway")))]);
    assert!(compile(&m, "k", MODEL, SENT).is_ok());
    assert_eq!(m.gets.borrow().len(), 3);
    assert!(m.elapsed_ms() >= 1400);
}

#[test]
fn signature_never_available_fails_after_bounded_retries_with_model_on_last() {
    let m = Mock::new(vec![(404, "{}".into())]);
    let e = compile(&m, "k", MODEL, SENT).unwrap_err();
    assert_eq!(e.code, "E_SIG_STATUS");
    let g = m.gets.borrow();
    assert_eq!(g.len(), 5);
    assert!(g[4].contains("&model=anthropic/claude-fable-5") && !g[3].contains("model="));
}

#[test]
fn ok_status_with_error_code_is_unavailable_not_a_signature() {
    let m = Mock::new(vec![(200, "{\"error_code\":\"NOT_READY\",\"message\":\"later\"}".into())]);
    assert_eq!(compile(&m, "k", MODEL, SENT).unwrap_err().code, "E_SIG_STATUS");
}

#[test]
fn text_for_other_bytes_or_missing_kind_is_refused() {
    let other = expected_text("provider_tee", MODEL, b"other request", RESP.as_bytes()).unwrap();
    let m = Mock::new(vec![(200, sig_json("provider_tee", &other))]);
    assert_eq!(compile(&m, "k", MODEL, SENT).unwrap_err().code, "E_SIG_TEXT");
    let m = Mock::new(vec![(200, sig_json("", &good_text("provider_tee")))]);
    assert_eq!(compile(&m, "k", MODEL, SENT).unwrap_err().code, "E_SIG_TEXT");
    let m = Mock::new(vec![(200, sig_json("weird", &good_text("gateway")))]);
    assert_eq!(compile(&m, "k", MODEL, SENT).unwrap_err().code, "E_SIG_TEXT");
}

#[test]
fn non_ecdsa_is_refused() {
    let j = sig_json("gateway", &good_text("gateway")).replace("ecdsa", "ed25519");
    assert_eq!(compile(&Mock::new(vec![(200, j)]), "k", MODEL, SENT).unwrap_err().code, "E_SIG_ALGO");
}

#[test]
fn ai_errors_are_reported_with_status() {
    let mut m = Mock::new(vec![]);
    m.ai_status = 429;
    m.ai_body = "{\"error\":\"slow down\"}".into();
    let e = compile(&m, "k", MODEL, SENT).unwrap_err();
    assert_eq!((e.code, e.detail.starts_with("429")), ("E_AI_STATUS", true));
}

#[test]
fn response_without_a_safe_id_is_refused() {
    for body in ["{\"choices\":[]}", "{\"id\":\"../x?y=1\"}", "not json", "{\"id\":\"\"}"] {
        let mut m = Mock::new(vec![]);
        m.ai_body = body.into();
        let e = compile(&m, "k", MODEL, SENT);
        assert!(matches!(e, Err(Failure { code: "E_AI_NO_ID", .. })), "{body}");
    }
}

#[test]
fn run_budget_is_enforced() {
    let mut m = Mock::new(vec![(404, "{}".into())]);
    m.step_ms = 12_000; // slow upstream: each call burns 12 s
    let e = compile(&m, "k", MODEL, SENT).unwrap_err();
    assert_eq!(e.code, "E_TIMEOUT");
}
