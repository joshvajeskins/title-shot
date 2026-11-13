# bout-sim

Shared referee for TITLE SHOT+. The same crate runs in the NEAR contract, the OutLayer forge and the browser.
Integer arithmetic only (`#![deny(clippy::float_arithmetic)]`), no HashMap iteration, no time, no I/O.

## API (default features: no wasm-bindgen, safe for the contract)

```rust
use bout_sim::{normalize_str, simulate, simulate_lite, spec::{Spec, check_sentence}, odds::odds, rulebook};

let spec: Spec = normalize_str(&ai_json)?;            // Raw AI JSON -> Spec | Reject{code}
check_sentence(&sentence)?;                           // 3..=120 chars, no control/bidi characters
let (winner, state_hash) = simulate_lite(&champ, &chall, seed32, rule_id); // contract path, no event storage
let fight = simulate(&champ, &chall, seed32, rule_id);                     // full event log (browser replay)
let (prefix, suffix) = rulebook::request_parts(model_id); // body = prefix ++ json_escape(sentence) ++ suffix
let h = rulebook::rulebook_hash();                    // sha256(prompt 00 schema 00 version)
let spec_bytes = spec.canonical_bytes(); let spec_hash = spec.hash();
let json = serde_json::to_string(&spec)?; Spec::from_json(&json)?;  // stored form, fully re-validated
```

Stats above 20 count half in a fight (`tune::eff`), so one maxed stat is a weak build.
`rule_id` 0..7 are the arena rules; any other u8 means "no modifier". Strings: control, bidi, zero-width, filler and blank characters (`spec::is_invisible`) never reach a stored string; a field with nothing visible is `E_EMPTY_FIELD`, one mixing them with text is `E_BAD_CHAR`. Reject codes (stable ABI):
`E_BAD_JSON E_REFUSED E_EMPTY_FIELD E_BAD_CHAR E_BAD_SCHOOL E_BAD_STYLE E_MOVE_COUNT E_UNKNOWN_MOVE E_DUP_MOVE E_BAD_STATS E_BAD_SENTENCE`.

Normalization rule worth knowing: a fighter always gets at least one Strike. If the AI picks three non-Strike moves
the third becomes the cheapest Strike of the fighter's school (its label is kept).

## Build and test

```
cargo test --release                               # unit, golden, fuzz, request round trip
cargo clippy --release --all-targets               # float_arithmetic denied at crate level
cargo run --release --bin sweep                    # 9 balance gates (G9 = adversarial hill-climb); add -- --write to save SWEEP.md
cargo run --release --bin sweep -- --climb-only    # G9 alone (~15 s); --restarts N --steps N --salt N for deeper or independent climbs
cargo run --release --bin golden                   # regenerate fixtures/golden.json (only after intentional rule changes)
./build-web.sh && node scripts/replay-golden.mjs   # wasm package + cross-target determinism check
```

`wasm` feature exports (JSON in, JSON out): `normalize`, `simulate`, `odds`, `rulebook_json`, `request_parts`,
`build_request`, `check_sentence`. Event schema: `EVENTS.md`. Balance numbers: `src/tune.rs`, `src/moves.rs`, `src/rules.rs`.
Balance tooling: `scripts/autotune.py` (damped move tuner), `scripts/regress.py`, `scripts/try.sh` (quick sweep).
