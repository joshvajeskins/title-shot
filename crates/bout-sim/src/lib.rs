//! bout-sim: the shared TITLE SHOT+ referee. One crate, three runtimes (NEAR contract, forge, browser).
//! Integer arithmetic only; identical results on every target.
#![deny(clippy::float_arithmetic)]

pub mod alloc;
pub mod events;
pub mod fighter;
pub mod moves;
pub mod odds;
pub mod policy;
pub mod reject;
pub mod rng;
pub mod rulebook;
pub mod rules;
pub mod sim;
pub mod spec;
pub mod testgen;
pub mod tune;
pub mod types;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use events::{Event, Outcome};
pub use sim::{simulate, simulate_lite, Fight};
pub use spec::{normalize, normalize_str, Raw, Reject, Spec};
