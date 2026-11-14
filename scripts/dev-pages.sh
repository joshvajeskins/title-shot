#!/usr/bin/env bash
# Local Pages: builds the site (unless SKIP_BUILD=1) and serves dist/ + functions/ with a local KV on http://127.0.0.1:8788.
# Secrets come from web/.dev.vars (pnpm exec tsx ../scripts/gen-dev-vars.ts). Set TS_CONTRACT_ID when regenerating it for a deployed contract.
set -euo pipefail
cd "$(dirname "$0")/../web"
if [ "$(uname)" = Darwin ]; then export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang; fi   # macOS: pin the system ar/clang
if [ "${SKIP_BUILD:-0}" != "1" ]; then pnpm exec vite build; fi
exec pnpm exec wrangler pages dev dist --port "${PORT:-8788}" --ip 127.0.0.1 --local-protocol http
