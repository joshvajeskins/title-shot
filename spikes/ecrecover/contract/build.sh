#!/usr/bin/env bash
# Build contract/target/near/ecrecover_spike.wasm. Rust 1.86 is required (wasm from 1.87+ is
# rejected by nearcore's VM); `--cfg near` makes near-sdk-env use host functions.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="--cfg near -C link-arg=-s" cargo +1.86.0 build --release --target wasm32-unknown-unknown
mkdir -p target/near
IN=target/wasm32-unknown-unknown/release/ecrecover_spike.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --signext-lowering "$IN" -o target/near/ecrecover_spike.wasm
else
  cp "$IN" target/near/ecrecover_spike.wasm
fi
shasum -a 256 target/near/ecrecover_spike.wasm
ls -l target/near/ecrecover_spike.wasm
