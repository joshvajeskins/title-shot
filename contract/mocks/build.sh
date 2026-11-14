#!/usr/bin/env bash
# Builds both mock contracts (Rust 1.86 via each crate's rust-toolchain.toml). Output: mocks/*/target/near/*.wasm
set -euo pipefail
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang
here="$(cd "$(dirname "$0")" && pwd)"
for m in outlayer-mock signer-mock; do
  (cd "$here/$m" && ~/.cargo/bin/cargo near build non-reproducible-wasm --no-abi --out-dir "$here/$m/target/near")
done
