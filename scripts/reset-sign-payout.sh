#!/usr/bin/env bash
# Manual reset for a payout the tick gave up signing (TICK log code SIGN_GAVE_UP, shown in /api/state and `tick:last`).
# sign_payout "succeeded" six times without returning a raw tx (the MPC callback kept failing), so the tick stopped calling it.
# Clearing the record lets the next tick try again from attempt 1 (back-off 1, 2, 4, 8, 8 minutes, then give up again).
# Usage: scripts/reset-sign-payout.sh <payout id> [--local]     (needs the Cloudflare login/token, like cf-setup.sh)
set -euo pipefail
ID="${1:?payout id}"
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "payout id must be a number" >&2; exit 2; }
cd "$(dirname "$0")/../web"
export PATH=/usr/bin:$PATH
WHERE=(--remote)
[ "${2:-}" = "--local" ] && WHERE=(--local)
pnpm exec wrangler kv key delete "signfail:$ID" --binding TS_KV "${WHERE[@]}"
echo "cleared signfail:$ID; the next tick signs payout $ID again"
