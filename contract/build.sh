#!/usr/bin/env bash
# Build contract/res/titleshot.wasm. Rust 1.86 (rust-toolchain.toml) is required: nearcore's VM rejects newer wasm.
# AR/CC are pinned because a non-system `ar` on PATH can shadow /usr/bin/ar on this machine and must never run.
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang
# Strip this machine's paths from panic messages: no home directory in the wasm, and the same bytes on any machine.
# cargo-near ignores ambient RUSTFLAGS; its --env override replaces the default `-C link-arg=-s`, so that is repeated here.
REPO_ROOT="$(cd .. && pwd)"   # this script already cd-ed into contract/
REMAP="--remap-path-prefix=$HOME/.cargo/registry/src=/cargo/registry/src --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$REPO_ROOT=/titleshot"
cargo near build non-reproducible-wasm --no-abi --locked --out-dir res --env "RUSTFLAGS=-C link-arg=-s $REMAP" 2>&1 | tail -15
# Final size pass (cargo-near already ran wasm-opt -Oz; --converge and --low-memory-unused, valid for lld-linked
# Rust wasm whose lowest 1 KB is never used, save another ~2%). Skipped when wasm-opt is not installed.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --converge --low-memory-unused --signext-lowering --strip-debug --strip-producers res/titleshot.wasm -o res/titleshot.wasm.tmp
  mv -f res/titleshot.wasm.tmp res/titleshot.wasm
fi
ls -l res/titleshot.wasm
shasum -a 256 res/titleshot.wasm
