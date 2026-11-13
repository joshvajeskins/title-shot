#!/bin/bash
# usage: scripts/try.sh  -> quick sweep, gate lines + key diagnostics
cd "$(dirname "$0")/.."
cargo run --release --bin sweep -- ${MODE:---quick} 2>&1 | grep -E "^\| G|^champion-seat|quantiles|^per-matchup|error|warning: unused" 
