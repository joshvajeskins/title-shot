#!/usr/bin/env bash
# Sandbox integration tests for the titleshot contract (real wasm + outlayer-mock + signer-mock).
#   ./run.sh                 build mocks (+ the contract wasm if missing), run everything
#   REBUILD=1 ./run.sh       always rebuild contract/res/titleshot.wasm first (do this after any crates/bout-sim change:
#                            the tests replay every bout natively and compare state hashes)
#   ./run.sh --test t03_bouts   any extra args go to `cargo test`
# TITLESHOT_WASM=/path/to/titleshot.wasm overrides the wasm under test.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# A non-system `ar` on PATH can shadow /usr/bin/ar on this machine and must never run.
if [ "$(uname)" = Darwin ]; then export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang; fi   # macOS: pin the system ar/clang
"$here/../mocks/build.sh" >/dev/null
if [ "${REBUILD:-}" = "1" ] || { [ -z "${TITLESHOT_WASM:-}" ] && [ ! -f "$here/../res/titleshot.wasm" ]; }; then
  "$here/../build.sh"
fi
cd "$here"
# near-workspaces needs a newer toolchain than the contract's pinned 1.86 (see rust-toolchain.toml here).
exec cargo test --no-fail-fast "$@" -- --test-threads="${THREADS:-4}"
