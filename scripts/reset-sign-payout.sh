#!/usr/bin/env bash
# Manual reset for a payout the tick gave up signing (TICK log code SIGN_GAVE_UP, shown in /api/state and `tick:last`).
# sign_payout "succeeded" six times without returning a raw tx (the MPC callback kept failing), so the tick stopped calling it.
# Clearing the record lets the next tick try again from attempt 1 (back-off 1, 2, 4, 8, 8 minutes, then give up again).
# Tick records are scoped by contract (KV key <contract>:signfail:<id>), so the contract id is required.
# Usage: CONTRACT_ID=<contract> scripts/reset-sign-payout.sh <payout id> [--local]     (needs the Cloudflare login/token, like cf-setup.sh)
set -euo pipefail
ID="${1:?payout id}"
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "payout id must be a number" >&2; exit 2; }
CONTRACT_ID=${CONTRACT_ID:-}
[[ "$CONTRACT_ID" =~ ^[a-z0-9._-]+\.testnet$ ]] || { echo "set CONTRACT_ID to the contract whose payout this is (for example staging.titleshot.testnet)" >&2; exit 2; }
KEY="$CONTRACT_ID:signfail:$ID"
cd "$(dirname "$0")/../web"
export PATH=/usr/bin:$PATH
WHERE=(--remote)
[ "${2:-}" = "--local" ] && WHERE=(--local)
pnpm exec wrangler kv key delete "$KEY" --binding TS_KV "${WHERE[@]}"
echo "cleared $KEY; the next tick signs payout $ID again"
