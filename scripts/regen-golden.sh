#!/usr/bin/env bash
# Regenerates web/test/fixtures/request-golden.json from NATIVE Rust (crates/bout-sim) and re-syncs the wasm copy used by the
# browser and the Pages Functions. Run it whenever crates/bout-sim's rulebook, prompt or schema changes; the Vitest suite fails
# until the wasm copy and the golden agree with the Rust crate (that is the point: the contract, forge and web must hash the same bytes).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" = Darwin ]; then export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang; fi   # macOS: pin the system ar/clang
(cd scripts/golden-gen && cargo run -q --release > ../../web/test/fixtures/request-golden.json)
./scripts/sync-sim.sh >/dev/null
echo "golden + wasm copy regenerated: $(node -e 'const g=require("./web/test/fixtures/request-golden.json");console.log(g.rulebook_hash.slice(0,16))')"
