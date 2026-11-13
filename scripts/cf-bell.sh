#!/usr/bin/env bash
# COORDINATOR ONLY (deploys): deploys the cron Worker `title-shot-bell` and gives it the SAME tick token the Pages project has.
# The token comes from $TICK_SECRET or .env.local (cf-setup.sh saves it there); it is piped to wrangler, never printed.
# Usage: PAGES_URL=https://title-shot.pages.dev scripts/cf-bell.sh      (PAGES_URL defaults to what worker-bell/wrangler.toml says)
# Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment (`set -a; . ./.env.local; set +a`).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang
W="pnpm --dir web exec wrangler"
envv() { sed -n "s/^$1=//p" .env.local 2>/dev/null | head -1 | tr -d '"'; }
TICK=${TICK_SECRET:-$(envv TICK_SECRET)}
[ -n "$TICK" ] || { echo "no TICK_SECRET in the environment or .env.local: run scripts/cf-setup.sh first so Pages and the bell share one token" >&2; exit 1; }
if [ -n "${PAGES_URL:-}" ]; then
  case "$PAGES_URL" in https://*) ;; *) echo "PAGES_URL must be an https URL" >&2; exit 1;; esac
  sed -i '' "s#^PAGES_URL = \".*\"#PAGES_URL = \"$PAGES_URL\"#" worker-bell/wrangler.toml
fi
cd worker-bell
$W deploy
printf '%s' "$TICK" | $W secret put TICK_SECRET >/dev/null && echo "secret TICK_SECRET set on title-shot-bell"
grep '^PAGES_URL' wrangler.toml
