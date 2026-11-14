#!/usr/bin/env bash
# Build the browser package: crates/bout-sim/pkg (wasm-bindgen --target web, `wasm` feature).
# The contract does NOT use this: it depends on the crate with default features (no wasm-bindgen).
set -euo pipefail
cd "$(dirname "$0")"
WB_VERSION="0.2.130"   # must equal the pinned `wasm-bindgen = "=..."` in Cargo.toml

WB="${WASM_BINDGEN:-}"
if [ -z "$WB" ]; then
  for c in "$(command -v wasm-bindgen || true)" "$HOME/.cargo/bin/wasm-bindgen" "/private/tmp/claude-501/wbroot/bin/wasm-bindgen"; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" --version | grep -q "$WB_VERSION"; then WB="$c"; break; fi
  done
fi
if [ -z "$WB" ]; then
  echo "wasm-bindgen $WB_VERSION not found; installing wasm-bindgen-cli $WB_VERSION ..." >&2
  cargo install wasm-bindgen-cli --version "$WB_VERSION" --locked
  WB="$HOME/.cargo/bin/wasm-bindgen"
fi
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

# the cdylib crate type is requested here so the crate stays a plain rlib for the contract and tests
cargo rustc --release --lib --target wasm32-unknown-unknown --features wasm --crate-type cdylib
rm -rf pkg
"$WB" --target web --out-dir pkg --out-name bout_sim "$(cd "$(dirname "$0")/../.." && pwd)/target/wasm32-unknown-unknown/release/bout_sim.wasm"
ls -l pkg
