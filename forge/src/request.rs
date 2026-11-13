//! The NEAR AI request body: PREFIX ++ json_escape(sentence) ++ SUFFIX, owned by the shared rulebook
//! crate so the forge, the contract and the browser build byte-identical requests.
pub use bout_sim::rulebook::{json_escape, request_parts};

/// Full request body bytes for a sentence.
pub fn build_body(model_id: &str, sentence: &str) -> Vec<u8> {
    bout_sim::rulebook::build_request(model_id, sentence)
}
