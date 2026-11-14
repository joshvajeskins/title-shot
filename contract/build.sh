#!/usr/bin/env bash
# Build contract/res/titleshot.wasm. Rust 1.86 (rust-toolchain.toml) is required: nearcore's VM rejects newer wasm.
# AR/CC are pinned because a fleet script named `ar` can shadow /usr/bin/ar on this machine and must never run.
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang
cargo near build non-reproducible-wasm --no-abi --locked --out-dir res 2>&1 | tail -15
mv -f res/titleshot.wasm res/titleshot.wasm.tmp 2>/dev/null && mv -f res/titleshot.wasm.tmp res/titleshot.wasm || true
ls -l res/titleshot.wasm
shasum -a 256 res/titleshot.wasm
