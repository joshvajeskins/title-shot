//! Test harness for the titleshot sandbox tests. The tests never import the contract crate: they speak
//! only the JSON interface in docs/CONTRACT.md against the real wasm and two mock contracts.
pub mod driver;
pub mod evm;
pub mod expect;
pub mod fixtures;
pub mod flows;
pub mod simx;
pub mod snap;
pub mod util;
pub mod world;
