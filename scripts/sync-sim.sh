#!/usr/bin/env bash
# Build the bout-sim wasm package and copy it into web/src/sim/pkg (used by the browser client and the Pages Functions).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" = Darwin ]; then export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang; fi   # macOS: pin the system ar/clang
if [ "${SKIP_BUILD:-0}" != "1" ]; then ./crates/bout-sim/build-web.sh >/dev/null; fi
mkdir -p web/src/sim/pkg
cp crates/bout-sim/pkg/bout_sim.js crates/bout-sim/pkg/bout_sim.d.ts crates/bout-sim/pkg/bout_sim_bg.wasm crates/bout-sim/pkg/bout_sim_bg.wasm.d.ts web/src/sim/pkg/
ls -l web/src/sim/pkg
